import { eq, and, inArray } from "drizzle-orm";
import type { Runtime, InstanceHandle, WorkloadId, NodeId, InstanceId, Workload } from "@boilerhouse/core";
import { generateInstanceId } from "@boilerhouse/core";
import type { DrizzleDb } from "@boilerhouse/db";
import { instances, workloads } from "@boilerhouse/db";
import { applyInstanceTransition, applyWorkloadTransition } from "./transitions";
import { pollHealth, createExecCheck, createHttpCheck } from "./health-check";
import type { HealthConfig, HealthCheckFn, HealthChecker } from "./health-check";
import type { BootstrapLogStore } from "./bootstrap-log-store";
import type { EventBus } from "./event-bus";

export interface PoolManagerOptions {
	healthChecker?: HealthChecker;
	bootstrapLogStore?: BootstrapLogStore;
	eventBus?: EventBus;
}

export class PoolManager {
	private readonly healthChecker: HealthChecker;
	private readonly warmingPromises = new Map<InstanceId, Promise<void>>();

	constructor(
		private readonly runtime: Runtime,
		private readonly db: DrizzleDb,
		private readonly nodeId: NodeId,
		options?: PoolManagerOptions,
	) {
		this.healthChecker = options?.healthChecker ?? pollHealth;
	}

	/**
	 * Starts a single pool instance, waits for it to become healthy, then
	 * transitions the workload to "created". Used during workload registration
	 * when a pool is configured.
	 */
	async prime(workloadId: WorkloadId): Promise<void> {
		const workloadRow = this.db.select().from(workloads).where(eq(workloads.workloadId, workloadId)).get();
		if (!workloadRow) throw new Error(`Workload not found: ${workloadId}`);
		const workload = workloadRow.config as Workload;
		const handle = await this.startPoolInstance(workloadId, workload);
		try {
			await this.runHealthChecks(handle, workload);
		} catch (err) {
			await this.runtime.destroy(handle).catch(() => {});
			this.db.delete(instances).where(eq(instances.instanceId, handle.instanceId)).run();
			throw err;
		}
		this.db.update(instances).set({ poolStatus: "ready" }).where(eq(instances.instanceId, handle.instanceId)).run();
		applyWorkloadTransition(this.db, workloadId, "creating", "created");
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
		await this.runHealthChecks(handle, workload);
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
		const targetSize = workload.pool?.size ?? 3;
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
				const handle: InstanceHandle = { instanceId: row.instanceId, running: row.status === "active" || row.status === "starting" };
				await this.runtime.destroy(handle);
				this.db.update(instances).set({ status: "destroyed", poolStatus: null }).where(eq(instances.instanceId, row.instanceId)).run();
			} catch {
				// Best-effort
			}
		}));
	}

	private async startAndReadyInstance(workloadId: WorkloadId, workload: Workload): Promise<void> {
		const handle = await this.startPoolInstance(workloadId, workload);
		let resolve!: () => void;
		let reject!: (err: unknown) => void;
		const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
		this.warmingPromises.set(handle.instanceId, promise);
		try {
			await this.runHealthChecks(handle, workload);
			this.db.update(instances).set({ poolStatus: "ready" }).where(eq(instances.instanceId, handle.instanceId)).run();
			resolve();
		} catch (err) {
			await this.runtime.destroy(handle).catch(() => {});
			this.db.delete(instances).where(eq(instances.instanceId, handle.instanceId)).run();
			reject(err);
		} finally {
			this.warmingPromises.delete(handle.instanceId);
		}
	}

	private async startPoolInstance(workloadId: WorkloadId, workload: Workload): Promise<InstanceHandle> {
		const instanceId = generateInstanceId();
		this.db.insert(instances).values({
			instanceId,
			workloadId,
			nodeId: this.nodeId,
			status: "starting",
			poolStatus: "warming",
			createdAt: new Date(),
		}).run();
		try {
			const handle = await this.runtime.create(workload, instanceId);
			await this.runtime.start(handle);
			applyInstanceTransition(this.db, instanceId, "starting", "started");
			return { instanceId, running: true };
		} catch (err) {
			this.db.delete(instances).where(eq(instances.instanceId, instanceId)).run();
			throw err;
		}
	}

	private async runHealthChecks(handle: InstanceHandle, workload: Workload): Promise<void> {
		if (!workload.health) return;
		const intervalMs = workload.health.interval_seconds * 1000;
		let check: HealthCheckFn;
		if (workload.health.exec) {
			check = createExecCheck(this.runtime, handle, workload.health.exec.command);
		} else if (workload.health.http_get) {
			const endpoint = await this.runtime.getEndpoint(handle);
			const port = endpoint.ports[0]!;
			const url = `http://${endpoint.host}:${port}${workload.health.http_get.path}`;
			check = createHttpCheck(url);
		} else {
			throw new Error("Workload health config has no exec or http_get probe");
		}
		const config: HealthConfig = {
			interval: intervalMs,
			unhealthyThreshold: workload.health.unhealthy_threshold,
			timeoutMs: Math.max(intervalMs * workload.health.unhealthy_threshold * 2, 120_000),
		};
		await this.healthChecker(check, config);
	}
}
