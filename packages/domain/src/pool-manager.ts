import { eq, and, inArray } from "drizzle-orm";
import type { Runtime, InstanceHandle, WorkloadId, InstanceId, Workload } from "@boilerhouse/core";
import type { DrizzleDb } from "@boilerhouse/db";
import { instances, workloads } from "@boilerhouse/db";
import { applyWorkloadTransition } from "./transitions";
import { pollHealth, createExecCheck, createHttpCheck } from "./health-check";
import type { HealthConfig, HealthCheckFn, HealthChecker } from "./health-check";
import type { InstanceManager } from "./instance-manager";
import type { BootstrapLogStore } from "./bootstrap-log-store";
import type { AuditLogger } from "./audit-logger";
import { createLogger } from "@boilerhouse/o11y";

export interface PoolManagerOptions {
	healthChecker?: HealthChecker;
	bootstrapLogStore?: BootstrapLogStore;
	audit?: AuditLogger;
}

const log = createLogger("PoolManager");

export class PoolManager {
	private readonly healthChecker: HealthChecker;
	private readonly warmingPromises = new Map<InstanceId, Promise<void>>();
	private readonly bootstrapLogStore?: BootstrapLogStore;
	private readonly audit?: AuditLogger;

	constructor(
		private readonly instanceManager: InstanceManager,
		private readonly runtime: Runtime,
		private readonly db: DrizzleDb,
		options?: PoolManagerOptions,
	) {
		this.healthChecker = options?.healthChecker ?? pollHealth;
		this.bootstrapLogStore = options?.bootstrapLogStore;
		this.audit = options?.audit;
	}

	/**
	 * Starts a single pool instance, waits for it to become healthy, then
	 * transitions the workload to "created". Used during workload registration
	 * when a pool is configured.
	 *
	 * When `drainExisting` is true (workload update flow), existing pool
	 * instances are destroyed after the new instance passes health checks
	 * but before the pool is replenished.
	 */
	async prime(workloadId: WorkloadId, options?: { drainExisting?: boolean }): Promise<void> {
		const workloadRow = this.db.select().from(workloads).where(eq(workloads.workloadId, workloadId)).get();
		if (!workloadRow) throw new Error(`Workload not found: ${workloadId}`);
		const workload = workloadRow.config as Workload;

		// Snapshot existing pool instance IDs before starting the new one
		const oldPoolIds = options?.drainExisting
			? this.db.select({ instanceId: instances.instanceId }).from(instances)
				.where(and(eq(instances.workloadId, workloadId), inArray(instances.poolStatus, ["warming", "ready"])))
				.all().map((r) => r.instanceId)
			: [];

		const startedAt = performance.now();
		const handle = await this.startPoolInstance(workloadId, workload);
		try {
			await this.runHealthChecks(handle, workload, workloadId);
		} catch (err) {
			await this.instanceManager.destroy(handle.instanceId).catch(() => {});
			throw err;
		}
		this.db.update(instances).set({ poolStatus: "ready" }).where(eq(instances.instanceId, handle.instanceId)).run();
		this.audit?.poolInstanceReady(handle.instanceId, workloadId, (performance.now() - startedAt) / 1000);

		// Drain old pool instances after healthcheck passes
		if (oldPoolIds.length > 0) {
			await Promise.all(oldPoolIds.map(async (id) => {
				try {
					await this.instanceManager.destroy(id);
				} catch (err) {
					log.warn({ instanceId: id, err }, "Failed to destroy old pool instance during update");
				}
			}));
		}

		applyWorkloadTransition(this.db, workloadId, "creating", "created");
		await this.replenish(workloadId);
	}

	/**
	 * Returns a ready pool instance for the given workload, acquiring it
	 * exclusively. Falls back to waiting for a warming instance or cold-booting
	 * a new one if the pool is empty.
	 */
	async acquire(workloadId: WorkloadId): Promise<InstanceHandle> {
		// Try ready instance first (synchronous — safe since Bun SQLite is sync and JS is single-threaded)
		const ready = this.db.select().from(instances)
			.where(and(eq(instances.workloadId, workloadId), eq(instances.poolStatus, "ready")))
			.get();
		if (ready) {
			this.db.update(instances).set({ poolStatus: "acquired" }).where(eq(instances.instanceId, ready.instanceId)).run();
			return { instanceId: ready.instanceId, running: true };
		}

		// Wait for any warming instance
		const warming = this.db.select({ instanceId: instances.instanceId }).from(instances)
			.where(and(eq(instances.workloadId, workloadId), eq(instances.poolStatus, "warming")))
			.get();
		if (warming) {
			const promise = this.warmingPromises.get(warming.instanceId);
			if (promise) {
				await promise;
				// After warming completes, try to acquire again
				return this.acquire(workloadId);
			}
		}

		// Pool empty — start a new instance on demand
		const workloadRow = this.db.select().from(workloads).where(eq(workloads.workloadId, workloadId)).get();
		if (!workloadRow) throw new Error(`Workload not found: ${workloadId}`);
		const workload = workloadRow.config as Workload;
		const handle = await this.startPoolInstance(workloadId, workload);
		await this.runHealthChecks(handle, workload, workloadId);
		this.db.update(instances).set({ poolStatus: "acquired" }).where(eq(instances.instanceId, handle.instanceId)).run();
		return { instanceId: handle.instanceId, running: true };
	}

	/**
	 * Refills the pool up to the configured target size (up to
	 * `max_fill_concurrency` instances at a time). Fire-and-forget safe.
	 */
	async replenish(workloadId: WorkloadId): Promise<void> {
		const workloadRow = this.db.select().from(workloads).where(eq(workloads.workloadId, workloadId)).get();
		if (!workloadRow) return;
		const workload = workloadRow.config as Workload;
		const targetSize = workload.pool?.size ?? 1;
		const maxConcurrency = workload.pool?.max_fill_concurrency ?? 2;

		// Count current pool instances (warming + ready)
		const current = this.db.select().from(instances)
			.where(and(
				eq(instances.workloadId, workloadId),
				inArray(instances.poolStatus, ["warming", "ready"]),
			))
			.all();

		const needed = targetSize - current.length;
		if (needed <= 0) return;

		// Start up to maxConcurrency instances in parallel
		const toStart = Math.min(needed, maxConcurrency);
		await Promise.all(
			Array.from({ length: toStart }, () => this.startAndReadyInstance(workloadId, workload)),
		);
	}

	/**
	 * Returns the count of ready pool instances for the given workload.
	 * Used by observability instrumentation for the pool depth gauge.
	 */
	getPoolDepth(workloadId: string): number {
		const rows = this.db
			.select({ instanceId: instances.instanceId })
			.from(instances)
			.where(and(eq(instances.workloadId, workloadId as WorkloadId), eq(instances.poolStatus, "ready")))
			.all();
		return rows.length;
	}

	/**
	 * Destroys all warming and ready pool instances for the given workload.
	 * Best-effort: errors during individual destroys are swallowed.
	 */
	async drain(workloadId: WorkloadId): Promise<void> {
		const poolInstances = this.db.select().from(instances)
			.where(and(
				eq(instances.workloadId, workloadId),
				inArray(instances.poolStatus, ["warming", "ready"]),
			))
			.all();

		await Promise.all(poolInstances.map(async (row) => {
			try {
				await this.instanceManager.destroy(row.instanceId);
			} catch (err) {
				log.warn({ instanceId: row.instanceId, err }, "Failed to destroy pool instance during drain");
			}
		}));
	}

	private async startAndReadyInstance(workloadId: WorkloadId, workload: Workload): Promise<void> {
		const startedAt = performance.now();
		const handle = await this.startPoolInstance(workloadId, workload);
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		this.warmingPromises.set(handle.instanceId, promise);
		try {
			await this.runHealthChecks(handle, workload, workloadId);
			this.db.update(instances).set({ poolStatus: "ready" }).where(eq(instances.instanceId, handle.instanceId)).run();
			this.audit?.poolInstanceReady(handle.instanceId, workloadId, (performance.now() - startedAt) / 1000);
			resolve();
		} catch (err) {
			await this.instanceManager.destroy(handle.instanceId).catch(() => {});
			reject(err);
		} finally {
			this.warmingPromises.delete(handle.instanceId);
		}
	}

	private makeOnLog(workloadId: WorkloadId): (line: string) => void {
		return (line: string) => {
			if (!this.bootstrapLogStore) return;
			this.bootstrapLogStore.append(workloadId, line);
			this.audit?.bootstrapLog(workloadId, line);
		};
	}

	private async startPoolInstance(workloadId: WorkloadId, workload: Workload): Promise<InstanceHandle> {
		return this.instanceManager.create(workloadId, workload, undefined, {
			poolStatus: "warming",
			onLog: this.makeOnLog(workloadId),
		});
	}

	private async runHealthChecks(handle: InstanceHandle, workload: Workload, workloadId?: WorkloadId): Promise<void> {
		if (!workload.health) return;
		const intervalMs = workload.health.interval_seconds * 1000;
		const onLog = workloadId ? this.makeOnLog(workloadId) : undefined;
		let check: HealthCheckFn;
		if (workload.health.exec) {
			check = createExecCheck(this.runtime, handle, workload.health.exec.command, onLog);
		} else if (workload.health.http_get) {
			const endpoint = await this.runtime.getEndpoint(handle);
			const port = endpoint.ports[0]!;
			const url = `http://${endpoint.host}:${port}${workload.health.http_get.path}`;
			check = createHttpCheck(url, onLog);
		} else {
			throw new Error("Workload health config has no exec or http_get probe");
		}
		const config: HealthConfig = {
			interval: intervalMs,
			unhealthyThreshold: workload.health.unhealthy_threshold,
			timeoutMs: Math.max(intervalMs * workload.health.unhealthy_threshold * 2, 120_000),
		};
		await this.healthChecker(check, config, onLog);
	}
}
