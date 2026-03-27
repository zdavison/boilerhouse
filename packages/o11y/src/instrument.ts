import { eq, and, notInArray, isNotNull, count, sum, sql } from "drizzle-orm";
import { statSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import type { Meter } from "@opentelemetry/api";
import type { DrizzleDb } from "@boilerhouse/db";
import { instances, claims, snapshots, workloads } from "@boilerhouse/db";
import type { NodeId, InstanceStatus, WorkloadId } from "@boilerhouse/core";
import { instrumentTenants, type TenantMetrics } from "./metrics/tenants";
import { instrumentInstances, type InstanceMetrics } from "./metrics/instances";
import { instrumentSnapshots, type SnapshotMetrics } from "./metrics/snapshots";
import { instrumentCapacity, type CapacityMetrics } from "./metrics/capacity";
import { instrumentPool, type PoolMetrics } from "./metrics/pool";
import { instrumentTriggers, type TriggerMetrics } from "./metrics/triggers";
import { instrumentWebSocket, type WebSocketMetrics } from "./metrics/websocket";
import { instrumentHealthCheck, type HealthCheckMetrics } from "./metrics/healthcheck";
import { instrumentNode, type NodeMetrics, type ContainerSnapshot } from "./metrics/node";
import { tenants } from "@boilerhouse/db";

/** Statuses that don't consume a runtime slot. */
const FREE_STATUSES: InstanceStatus[] = ["destroyed", "hibernated"];

/** Minimal EventBus interface — avoids importing the concrete class. */
interface EventBusLike {
	on(handler: (event: { type: string }) => void): void;
}

/** Minimal ResourceLimiter interface for queue depth. */
interface ResourceLimiterLike {
	queueDepth(nodeId: NodeId): number;
}

/** Minimal PoolManager interface for pool depth. */
interface PoolManagerLike {
	getPoolDepth(workloadId: string): number;
}

/** Provider for container resource stats. */
export interface ContainerStatsProvider {
	getContainerStats(): ContainerSnapshot[];
}

export interface InstrumentDeps {
	eventBus: EventBusLike;
	db: DrizzleDb;
	nodeId: NodeId;
	maxInstances: number;
	resourceLimiter?: ResourceLimiterLike;
	poolManager?: PoolManagerLike;
	containerStatsProvider?: ContainerStatsProvider;
	/** Cache directory for overlay blobs — used to resolve blob keys to file paths. */
	overlayCacheDir?: string;
}

export interface AllMetrics {
	tenants: TenantMetrics;
	instances: InstanceMetrics;
	snapshots: SnapshotMetrics;
	capacity: CapacityMetrics;
	pool: PoolMetrics;
	triggers: TriggerMetrics;
	ws: WebSocketMetrics;
	healthcheck: HealthCheckMetrics;
	node: NodeMetrics;
}

/**
 * Wires up all domain metrics:
 * - Registers observable gauges backed by DB queries
 * - Subscribes to EventBus for counter increments
 *
 * All `workload` labels use human-readable workload names (not UUIDs).
 */
export function instrumentFromEventBus(meter: Meter, deps: InstrumentDeps): AllMetrics {
	const { eventBus, db, nodeId, maxInstances, resourceLimiter } = deps;

	/** Resolves a workloadId to its human-readable name. */
	function workloadName(workloadId: string): string {
		const row = db
			.select({ name: workloads.name })
			.from(workloads)
			.where(eq(workloads.workloadId, workloadId as WorkloadId))
			.get();
		return row?.name ?? workloadId;
	}

	// ── Tenant metrics ─────────────────────────────────────────────────────
	const tenantMetrics = instrumentTenants(meter, {
		getActiveCounts() {
			const rows = db
				.select({
					workload: workloads.name,
					count: count(),
				})
				.from(claims)
				.innerJoin(workloads, eq(claims.workloadId, workloads.workloadId))
				.where(eq(claims.status, "active"))
				.groupBy(workloads.name)
				.all();
			return rows.map((r) => ({ workload: r.workload, count: r.count }));
		},
		getOverlaySizes() {
			const rows = db
				.select({
					tenant: tenants.tenantId,
					workload: workloads.name,
					ref: tenants.dataOverlayRef,
				})
				.from(tenants)
				.innerJoin(workloads, eq(tenants.workloadId, workloads.workloadId))
				.where(isNotNull(tenants.dataOverlayRef))
				.all();
			return rows
				.filter((r) => r.ref)
				.map((r) => {
					// Ref is either an absolute file path (legacy) or a blob key like "tenantId/workloadId".
					// For blob keys, resolve through the overlay cache directory.
					const filePath = isAbsolute(r.ref!)
						? r.ref!
						: deps.overlayCacheDir
							? join(deps.overlayCacheDir, r.ref!)
							: r.ref!;
					let bytes = 0;
					try { bytes = statSync(filePath).size; } catch {}
					return { tenant: r.tenant, workload: r.workload, bytes };
				})
				.filter((r) => r.bytes > 0);
		},
	});

	// ── Instance metrics ───────────────────────────────────────────────────
	const instanceMetrics = instrumentInstances(meter, {
		getInstanceCounts() {
			const rows = db
				.select({
					workload: workloads.name,
					node: instances.nodeId,
					status: instances.status,
					count: count(),
				})
				.from(instances)
				.innerJoin(workloads, eq(instances.workloadId, workloads.workloadId))
				.groupBy(workloads.name, instances.nodeId, instances.status)
				.all();
			return rows.map((r) => ({
				workload: r.workload,
				node: r.node,
				status: r.status,
				count: r.count,
			}));
		},
	});

	// ── Snapshot metrics ───────────────────────────────────────────────────
	const snapshotMetrics = instrumentSnapshots(meter, {
		getGoldenQueueDepth() {
			return 0;
		},
		getDiskTotals() {
			const rows = db
				.select({
					workload: workloads.name,
					type: snapshots.type,
					bytes: sum(snapshots.sizeBytes),
				})
				.from(snapshots)
				.innerJoin(workloads, eq(snapshots.workloadId, workloads.workloadId))
				.groupBy(workloads.name, snapshots.type)
				.all();
			return rows.map((r) => ({
				workload: r.workload,
				type: r.type,
				bytes: Number(r.bytes ?? 0),
			}));
		},
		getDiskAvgPerTenant() {
			const rows = db
				.select({
					workload: workloads.name,
					bytes: sql<number>`CAST(SUM(${snapshots.sizeBytes}) AS REAL) / MAX(COUNT(DISTINCT ${snapshots.tenantId}), 1)`,
				})
				.from(snapshots)
				.innerJoin(workloads, eq(snapshots.workloadId, workloads.workloadId))
				.where(eq(snapshots.type, "tenant"))
				.groupBy(workloads.name)
				.all();
			return rows.map((r) => ({
				workload: r.workload,
				bytes: Number(r.bytes ?? 0),
			}));
		},
		getDiskPerTenant() {
			const rows = db
				.select({
					tenant: snapshots.tenantId,
					workload: workloads.name,
					bytes: sum(snapshots.sizeBytes),
				})
				.from(snapshots)
				.innerJoin(workloads, eq(snapshots.workloadId, workloads.workloadId))
				.where(eq(snapshots.type, "tenant"))
				.groupBy(snapshots.tenantId, workloads.name)
				.all();
			return rows
				.filter((r) => r.tenant != null)
				.map((r) => ({
					tenant: r.tenant!,
					workload: r.workload,
					bytes: Number(r.bytes ?? 0),
				}));
		},
		getSnapshotCounts() {
			const rows = db
				.select({
					workload: workloads.name,
					type: snapshots.type,
					count: count(),
				})
				.from(snapshots)
				.innerJoin(workloads, eq(snapshots.workloadId, workloads.workloadId))
				.groupBy(workloads.name, snapshots.type)
				.all();
			return rows.map((r) => ({
				workload: r.workload,
				type: r.type,
				count: r.count,
			}));
		},
	});

	// ── Capacity metrics ───────────────────────────────────────────────────
	const capacityMetrics = instrumentCapacity(meter, {
		getCapacityMax() {
			return [{ node: nodeId, max: maxInstances }];
		},
		getCapacityUsed() {
			const [row] = db
				.select({ count: count() })
				.from(instances)
				.where(
					and(
						eq(instances.nodeId, nodeId),
						notInArray(instances.status, FREE_STATUSES),
					),
				)
				.all();
			return [{ node: nodeId, used: row?.count ?? 0 }];
		},
		getQueueDepths() {
			return [{ node: nodeId, depth: resourceLimiter?.queueDepth(nodeId) ?? 0 }];
		},
	});

	// ── Pool metrics ───────────────────────────────────────────────────────
	const poolMetrics = instrumentPool(meter, {
		getPoolDepths() {
			// Count ready pool instances per workload
			const rows = db
				.select({
					workload: workloads.name,
					count: count(),
				})
				.from(instances)
				.innerJoin(workloads, eq(instances.workloadId, workloads.workloadId))
				.where(eq(instances.poolStatus, "ready"))
				.groupBy(workloads.name)
				.all();
			return rows.map((r) => ({ workload: r.workload, depth: r.count }));
		},
	});

	// ── Trigger metrics ───────────────────────────────────────────────────
	const triggerMetrics = instrumentTriggers(meter);

	// ── WebSocket metrics ─────────────────────────────────────────────────
	const wsMetrics = instrumentWebSocket(meter);

	// ── Health check metrics ──────────────────────────────────────────────
	const healthcheckMetrics = instrumentHealthCheck(meter);

	// ── Node / container resource metrics ─────────────────────────────────
	const nodeMetrics = instrumentNode(meter, {
		getContainerStats: () => deps.containerStatsProvider?.getContainerStats() ?? [],
	});

	// ── EventBus → counter subscriptions ───────────────────────────────────

	/** Transitional states we time. Map key is instanceId. */
	const TRANSITIONAL_STATUSES = new Set(["starting", "restoring", "hibernating", "destroying"]);
	const inFlight = new Map<string, { status: string; startedAt: number; workload: string }>();
	/** Tracks last known status per instance so we can emit `from` on transitions. */
	const lastStatus = new Map<string, string>();

	eventBus.on((event) => {
		if (event.type === "tenant.claimed") {
			const e = event as { tenantId?: string; source?: string; workloadId?: string; durationMs?: number };
			const wname = workloadName(String(e.workloadId ?? ""));
			tenantMetrics.claims.add(1, {
				workload: wname,
				source: String(e.source ?? ""),
				outcome: "ok",
			});
			if (e.durationMs != null) {
				tenantMetrics.claimDuration.record(e.durationMs / 1000, {
					workload: wname,
					source: String(e.source ?? ""),
					tenant: String(e.tenantId ?? ""),
				});
			}
		}

		if (event.type === "tenant.released") {
			const e = event as { tenantId?: string; workloadId?: string; usageSeconds?: number };
			const wname = workloadName(String(e.workloadId ?? ""));
			tenantMetrics.releases.add(1, { workload: wname });
			if (e.usageSeconds != null && e.usageSeconds > 0) {
				tenantMetrics.usageSeconds.add(e.usageSeconds, {
					tenant: String(e.tenantId ?? ""),
					workload: wname,
				});
			}
		}

		if (event.type === "pool.instance.ready") {
			const e = event as { workloadId?: string; durationSeconds?: number };
			poolMetrics.coldStartDuration.record(Number(e.durationSeconds ?? 0), {
				workload: workloadName(String(e.workloadId ?? "")),
			});
		}

		if (event.type === "idle.timeout") {
			instanceMetrics.idleTimeouts.add(1);
		}

		if (event.type === "trigger.dispatched") {
			const e = event as { source?: string; durationMs?: number };
			triggerMetrics.dispatches.add(1, {
				type: String(e.source ?? "unknown"),
				outcome: "ok",
			});
			if (e.durationMs != null) {
				triggerMetrics.dispatchDuration.record(e.durationMs / 1000, {
					type: String(e.source ?? "unknown"),
				});
			}
		}

		if (event.type === "trigger.error") {
			const e = event as { triggerName?: string };
			triggerMetrics.dispatches.add(1, {
				type: String(e.triggerName ?? "unknown"),
				outcome: "error",
			});
		}

		if (event.type === "instance.state") {
			const e = event as { instanceId?: string; status?: string; workloadId?: string };
			const instanceId = String(e.instanceId ?? "");
			const status = String(e.status ?? "");
			const wname = workloadName(String(e.workloadId ?? ""));

			const from = lastStatus.get(instanceId) ?? "none";
			lastStatus.set(instanceId, status);

			instanceMetrics.transitions.add(1, {
				from,
				to: status,
				workload: wname,
			});

			// Complete any in-flight timing for this instance
			const pending = inFlight.get(instanceId);
			if (pending) {
				inFlight.delete(instanceId);
				const durationSeconds = (performance.now() - pending.startedAt) / 1000;
				instanceMetrics.transitionDuration.record(durationSeconds, {
					from: pending.status,
					workload: pending.workload,
				});
			}

			// Start timing if entering a transitional state
			if (TRANSITIONAL_STATUSES.has(status)) {
				inFlight.set(instanceId, { status, startedAt: performance.now(), workload: wname });
			}

			// Clean up tracking for terminal states
			if (status === "destroyed") {
				lastStatus.delete(instanceId);
			}
		}
	});

	return {
		tenants: tenantMetrics,
		instances: instanceMetrics,
		snapshots: snapshotMetrics,
		capacity: capacityMetrics,
		pool: poolMetrics,
		triggers: triggerMetrics,
		ws: wsMetrics,
		healthcheck: healthcheckMetrics,
		node: nodeMetrics,
	};
}
