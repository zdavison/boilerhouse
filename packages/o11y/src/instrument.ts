import { eq, and, notInArray, count, sum, sql } from "drizzle-orm";
import type { Meter } from "@opentelemetry/api";
import type { DrizzleDb } from "@boilerhouse/db";
import { instances, tenants, claims, snapshots, workloads } from "@boilerhouse/db";
import type { NodeId, InstanceStatus, WorkloadId } from "@boilerhouse/core";
import { instrumentTenants, type TenantMetrics } from "./metrics/tenants";
import { instrumentInstances, type InstanceMetrics } from "./metrics/instances";
import { instrumentSnapshots, type SnapshotMetrics } from "./metrics/snapshots";
import { instrumentCapacity, type CapacityMetrics } from "./metrics/capacity";

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

/** Minimal GoldenCreator interface for queue depth. */
interface GoldenCreatorLike {
	readonly pending: number;
}

export interface InstrumentDeps {
	eventBus: EventBusLike;
	db: DrizzleDb;
	nodeId: NodeId;
	maxInstances: number;
	resourceLimiter?: ResourceLimiterLike;
	goldenCreator?: GoldenCreatorLike;
}

export interface AllMetrics {
	tenants: TenantMetrics;
	instances: InstanceMetrics;
	snapshots: SnapshotMetrics;
	capacity: CapacityMetrics;
}

/**
 * Wires up all domain metrics:
 * - Registers observable gauges backed by DB queries
 * - Subscribes to EventBus for counter increments
 *
 * All `workload` labels use human-readable workload names (not UUIDs).
 */
export function instrumentFromEventBus(meter: Meter, deps: InstrumentDeps): AllMetrics {
	const { eventBus, db, nodeId, maxInstances, resourceLimiter, goldenCreator } = deps;

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
				.innerJoin(tenants, eq(claims.tenantId, tenants.tenantId))
				.innerJoin(workloads, eq(tenants.workloadId, workloads.workloadId))
				.where(eq(claims.status, "active"))
				.groupBy(workloads.name)
				.all();
			return rows.map((r) => ({ workload: r.workload, count: r.count }));
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
			return goldenCreator?.pending ?? 0;
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

	// ── EventBus → counter subscriptions ───────────────────────────────────

	eventBus.on((event) => {
		if (event.type === "tenant.claimed") {
			const e = event as { source?: string; workloadId?: string };
			tenantMetrics.claims.add(1, {
				workload: workloadName(String(e.workloadId ?? "")),
				source: String(e.source ?? ""),
				outcome: "ok",
			});
		}

		if (event.type === "tenant.released") {
			const e = event as { workloadId?: string };
			tenantMetrics.releases.add(1, {
				workload: workloadName(String(e.workloadId ?? "")),
			});
		}

		if (event.type === "instance.state") {
			const e = event as { status?: string; workloadId?: string };
			instanceMetrics.transitions.add(1, {
				to: String(e.status ?? ""),
				workload: workloadName(String(e.workloadId ?? "")),
			});
		}
	});

	return {
		tenants: tenantMetrics,
		instances: instanceMetrics,
		snapshots: snapshotMetrics,
		capacity: capacityMetrics,
	};
}
