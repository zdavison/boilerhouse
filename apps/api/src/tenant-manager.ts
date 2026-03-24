import { eq } from "drizzle-orm";
import type {
	InstanceId,
	InstanceHandle,
	WorkloadId,
	NodeId,
	TenantId,
	Endpoint,
	ClaimStatus,
	Workload,
} from "@boilerhouse/core";
import {
	generateClaimId,
	InvalidTransitionError,
} from "@boilerhouse/core";
import type { DrizzleDb, ActivityLog } from "@boilerhouse/db";
import { instances, tenants, workloads, claims } from "@boilerhouse/db";
import type { Logger } from "@boilerhouse/o11y";
import { applyClaimTransition } from "./transitions";
import { instanceHandleFrom } from "./instance-manager";
import type { InstanceManager } from "./instance-manager";
import type { TenantDataStore } from "./tenant-data";
import type { IdleMonitor } from "./idle-monitor";
import type { WatchDirsPoller } from "./watch-dirs-poller";
import type { EventBus } from "./event-bus";
import type { PoolManager } from "./pool-manager";

export type ClaimSource = "existing" | "cold+data" | "cold" | "pool" | "pool+data";

export interface ClaimResult {
	tenantId: TenantId;
	instanceId: InstanceId;
	endpoint: Endpoint | null;
	source: ClaimSource;
	latencyMs: number;
}

export class TenantManager {
	/** Per-tenant+workload lock to prevent duplicate claims from concurrent requests. */
	private readonly inflightClaims = new Map<string, Promise<ClaimResult>>();

	constructor(
		private readonly instanceManager: InstanceManager,
		private readonly db: DrizzleDb,
		private readonly activityLog: ActivityLog,
		private readonly nodeId: NodeId,
		private readonly tenantDataStore: TenantDataStore,
		private readonly idleMonitor?: IdleMonitor,
		private readonly log?: Logger,
		private readonly eventBus?: EventBus,
		private readonly watchDirsPoller?: WatchDirsPoller,
		private readonly poolManager?: PoolManager,
	) {}

	/**
	 * Claims an instance for the given tenant.
	 *
	 * The claim row acts as a concurrency guard via UNIQUE constraint on tenantId.
	 *
	 * Claim hierarchy:
	 * 1. Existing active claim
	 * 2. Pool path (if poolManager is configured)
	 * 3. Cold boot fallback
	 */
	async claim(tenantId: TenantId, workloadId: WorkloadId): Promise<ClaimResult> {
		const key = `${tenantId}:${workloadId}`;
		const inflight = this.inflightClaims.get(key);
		if (inflight) return inflight;

		const promise = this.claimInner(tenantId, workloadId).finally(() => {
			this.inflightClaims.delete(key);
		});
		this.inflightClaims.set(key, promise);
		return promise;
	}

	private async claimInner(tenantId: TenantId, workloadId: WorkloadId): Promise<ClaimResult> {
		const start = performance.now();

		// 1. Check for existing claim
		const existingClaim = this.db.select().from(claims)
			.where(eq(claims.tenantId, tenantId)).get();

		if (existingClaim?.status === "active" && existingClaim.instanceId) {
			// Verify the instance is actually running (it may have been destroyed directly)
			const instanceRow = this.db.select({ status: instances.status })
				.from(instances)
				.where(eq(instances.instanceId, existingClaim.instanceId))
				.get();

			if (instanceRow?.status === "active" || instanceRow?.status === "starting") {
				// Instance is active or still starting — return it
				const handle = instanceHandleFrom(existingClaim.instanceId, instanceRow.status);
				const endpoint = await this.safeGetEndpoint(handle);
				return {
					tenantId,
					instanceId: existingClaim.instanceId,
					endpoint,
					source: "existing",
					latencyMs: performance.now() - start,
				};
			}

			// Instance is gone — delete stale claim and proceed
			this.db.delete(claims).where(eq(claims.claimId, existingClaim.claimId)).run();
		} else if (existingClaim?.status === "creating" || existingClaim?.status === "releasing") {
			throw new InvalidTransitionError("claim", existingClaim.status, "created");
		}

		// 2. Upsert tenant identity row first (FK target for claims)
		this.upsertTenantIdentity(tenantId, workloadId);

		// 3. Reserve claim slot (UNIQUE on tenantId prevents races)
		const claimId = generateClaimId();
		this.db.insert(claims).values({ claimId, tenantId, status: "creating", createdAt: new Date() }).run();

		try {
			// 4. Pool path (if configured) — acquire a pre-warmed instance
			if (this.poolManager) {
				const instance = await this.poolManager.acquire(workloadId);
				const hasData = this.tenantDataStore.hasOverlay(tenantId, workloadId);
				await this.tenantDataStore.injectOverlay(instance, tenantId, workloadId);
				this.updateInstanceClaimed(instance.instanceId);
				// Clear pool status — instance is now a regular active instance
				this.db.update(instances).set({ poolStatus: null }).where(eq(instances.instanceId, instance.instanceId)).run();
				this.db.update(claims).set({ instanceId: instance.instanceId, status: "active" }).where(eq(claims.claimId, claimId)).run();
				this.db.update(tenants).set({ lastActivity: new Date() }).where(eq(tenants.tenantId, tenantId)).run();
				const endpoint = await this.safeGetEndpoint(instance);
				const latencyMs = performance.now() - start;
				const source: ClaimSource = hasData ? "pool+data" : "pool";
				this.logClaim(tenantId, instance.instanceId, workloadId, source);
				this.startIdleWatch(instance.instanceId, workloadId);
				this.poolManager.replenish(workloadId).catch(() => {});
				return { tenantId, instanceId: instance.instanceId, endpoint, source, latencyMs };
			}

			// 4b. Cold boot fallback
			const handle = await this.createViaColdBoot(tenantId, workloadId);

			// 5. Transition claim to active
			this.db.update(claims)
				.set({ instanceId: handle.instanceId, status: "active" })
				.where(eq(claims.claimId, claimId)).run();

			// 6. Update tenant activity
			this.db.update(tenants).set({ lastActivity: new Date() })
				.where(eq(tenants.tenantId, tenantId)).run();

			const endpoint = await this.safeGetEndpoint(handle);
			const latencyMs = performance.now() - start;
			this.logClaim(tenantId, handle.instanceId, workloadId, handle.source);
			this.startIdleWatch(handle.instanceId, workloadId);

			return { tenantId, instanceId: handle.instanceId, endpoint, source: handle.source, latencyMs };
		} catch (err) {
			this.db.delete(claims).where(eq(claims.claimId, claimId)).run();
			throw err;
		}
	}

	/**
	 * Releases a tenant's instance.
	 *
	 * Extracts overlay data from the running container, destroys the instance,
	 * and replenishes the pool if a PoolManager is configured.
	 *
	 * No-op if the tenant has no active claim.
	 */
	async release(tenantId: TenantId): Promise<void> {
		const claim = this.db.select().from(claims)
			.where(eq(claims.tenantId, tenantId)).get();

		if (!claim?.instanceId) return;

		const instanceId = claim.instanceId;

		applyClaimTransition(this.db, claim.claimId, claim.status as ClaimStatus, "release");

		if (this.idleMonitor) {
			this.idleMonitor.unwatch(instanceId);
		}

		if (this.watchDirsPoller) {
			this.watchDirsPoller.stopPolling(instanceId);
		}

		// Get tenant row for workloadId
		const tenantRow = this.db.select().from(tenants)
			.where(eq(tenants.tenantId, tenantId)).get();

		if (!tenantRow) return;

		// Extract overlay data from the running container, then destroy and replenish pool
		const handle: InstanceHandle = { instanceId, running: true };
		await this.tenantDataStore.extractOverlay(handle, tenantId, tenantRow.workloadId);
		await this.instanceManager.destroy(instanceId);
		if (this.poolManager) {
			this.poolManager.replenish(tenantRow.workloadId).catch(() => {});
		}

		// Delete the claim — tenant identity (with lastSnapshotId) persists
		this.db.delete(claims).where(eq(claims.claimId, claim.claimId)).run();

		this.activityLog.log({
			event: "tenant.released",
			tenantId,
			instanceId,
			workloadId: tenantRow.workloadId,
			nodeId: this.nodeId,
		});
	}

	/** Cold boot create path: create a fresh instance from the workload definition. */
	private async createViaColdBoot(
		tenantId: TenantId,
		workloadId: WorkloadId,
	): Promise<InstanceHandle & { source: ClaimSource }> {
		const workloadRow = this.db
			.select()
			.from(workloads)
			.where(eq(workloads.workloadId, workloadId))
			.get();

		if (!workloadRow) {
			throw new Error(`Workload not found: ${workloadId}`);
		}

		const tenantRow = this.db
			.select()
			.from(tenants)
			.where(eq(tenants.tenantId, tenantId))
			.get();

		// Check for data overlay (cold boot + data path)
		const overlayPath = tenantRow
			? this.tenantDataStore.restoreOverlay(tenantId, workloadId)
			: null;

		const source: ClaimSource = overlayPath ? "cold+data" : "cold";
		this.log?.info({ tenantId, workloadId, source }, `Claiming via ${source}`);

		const handle = await this.instanceManager.create(
			workloadId,
			workloadRow.config as Workload,
			tenantId,
		);

		this.updateInstanceClaimed(handle.instanceId);

		if (overlayPath) {
			await this.instanceManager.injectOverlay(handle.instanceId, overlayPath);
		}

		return { ...handle, source };
	}

	/** Returns the endpoint, or null for containers with no exposed ports. */
	private async safeGetEndpoint(handle: InstanceHandle): Promise<Endpoint | null> {
		const endpoint = await this.instanceManager.getEndpoint(handle);
		if (endpoint.ports.length === 0) return null;
		return endpoint;
	}

	/**
	 * Inserts or updates the tenant identity row (no status, no instanceId).
	 */
	private upsertTenantIdentity(
		tenantId: TenantId,
		workloadId: WorkloadId,
	): void {
		const existing = this.db
			.select()
			.from(tenants)
			.where(eq(tenants.tenantId, tenantId))
			.get();

		if (!existing) {
			this.db
				.insert(tenants)
				.values({
					tenantId,
					workloadId,
					lastActivity: new Date(),
					createdAt: new Date(),
				})
				.run();
		}
	}

	/** Sets claimedAt and lastActivity on the instance row. */
	private updateInstanceClaimed(instanceId: InstanceId): void {
		const now = new Date();
		this.db
			.update(instances)
			.set({ claimedAt: now, lastActivity: now })
			.where(eq(instances.instanceId, instanceId))
			.run();
	}

	/** Logs a tenant.claimed event. */
	private logClaim(
		tenantId: TenantId,
		instanceId: InstanceId,
		workloadId: WorkloadId,
		source: ClaimSource,
	): void {
		this.activityLog.log({
			event: "tenant.claimed",
			tenantId,
			instanceId,
			workloadId,
			nodeId: this.nodeId,
			metadata: { source },
		});
	}

	/** Starts idle monitoring for a newly claimed instance, if an IdleMonitor is configured. */
	private startIdleWatch(instanceId: InstanceId, workloadId: WorkloadId): void {
		if (!this.idleMonitor) return;

		const workloadRow = this.db
			.select()
			.from(workloads)
			.where(eq(workloads.workloadId, workloadId))
			.get();

		const idle = workloadRow?.config?.idle;
		this.idleMonitor.watch(instanceId, {
			timeoutMs: ((idle?.timeout_seconds as number | undefined) ?? 300) * 1000,
			action: idle?.action ?? "hibernate",
		});

		const watchDirs = idle?.watch_dirs as string[] | undefined;
		if (watchDirs?.length && this.watchDirsPoller) {
			this.watchDirsPoller.startPolling(instanceId, watchDirs);
		}
	}
}
