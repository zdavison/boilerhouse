import { eq, and } from "drizzle-orm";
import type {
	InstanceId,
	InstanceHandle,
	WorkloadId,
	NodeId,
	TenantId,
	ClaimStatus,
	ClaimId,
	Workload,
	ClaimSource,
	ClaimResult,
} from "@boilerhouse/core";
import {
	generateClaimId,
	InvalidTransitionError,
} from "@boilerhouse/core";
import type { DrizzleDb } from "@boilerhouse/db";
import { instances, tenants, workloads, claims } from "@boilerhouse/db";
import type { Logger } from "@boilerhouse/o11y";
import { applyClaimTransition } from "./transitions";
import { instanceHandleFrom } from "./transitions";
import type { InstanceManager } from "./instance-manager";
import type { TenantDataStore } from "./tenant-data";
import type { IdleMonitor } from "./idle-monitor";
import type { WatchDirsPoller } from "./watch-dirs-poller";
import type { PoolManager } from "./pool-manager";
import type { AuditLogger } from "./audit-logger";

export type { ClaimSource, ClaimResult } from "@boilerhouse/core";

export interface TenantManagerOptions {
	idleMonitor?: IdleMonitor;
	log?: Logger;
	watchDirsPoller?: WatchDirsPoller;
	poolManager?: PoolManager;
}

export class TenantManager {
	/** Per-tenant+workload lock to prevent duplicate claims from concurrent requests. */
	private readonly inflightClaims = new Map<string, Promise<ClaimResult>>();
	private readonly idleMonitor?: IdleMonitor;
	private readonly log?: Logger;
	private readonly watchDirsPoller?: WatchDirsPoller;
	private readonly poolManager?: PoolManager;

	constructor(
		private readonly instanceManager: InstanceManager,
		private readonly db: DrizzleDb,
		private readonly audit: AuditLogger,
		private readonly nodeId: NodeId,
		private readonly tenantDataStore: TenantDataStore,
		options?: TenantManagerOptions,
	) {
		this.idleMonitor = options?.idleMonitor;
		this.log = options?.log;
		this.watchDirsPoller = options?.watchDirsPoller;
		this.poolManager = options?.poolManager;
	}

	/**
	 * Claims an instance for the given tenant.
	 *
	 * Claim hierarchy:
	 * 1. Existing active claim (fast path)
	 * 2. Pool path (if poolManager is configured and no tenant overlay)
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

	/**
	 * Releases a tenant's instance.
	 *
	 * Extracts overlay data from the running container, destroys the instance,
	 * and replenishes the pool if a PoolManager is configured.
	 *
	 * No-op if the tenant has no active claim.
	 */
	async release(tenantId: TenantId, workloadId: WorkloadId): Promise<void> {
		const claim = this.db.select().from(claims)
			.where(and(eq(claims.tenantId, tenantId), eq(claims.workloadId, workloadId))).get();

		if (!claim?.instanceId) return;

		const instanceId = claim.instanceId;

		// Capture claimedAt before the instance is modified
		const instanceRow = this.db.select({ claimedAt: instances.claimedAt }).from(instances)
			.where(eq(instances.instanceId, instanceId)).get();
		const usageSeconds = instanceRow?.claimedAt
			? (Date.now() - instanceRow.claimedAt.getTime()) / 1000
			: undefined;

		applyClaimTransition(this.db, claim.claimId, claim.status as ClaimStatus, "release");

		if (this.idleMonitor) {
			this.idleMonitor.unwatch(instanceId);
		}

		if (this.watchDirsPoller) {
			this.watchDirsPoller.stopPolling(instanceId);
		}

		// Extract overlay data from the running container, then hibernate or destroy
		const handle: InstanceHandle = { instanceId, running: true };
		const hasOverlay = await this.tenantDataStore.extractOverlay(handle, tenantId, workloadId);
		if (hasOverlay) {
			await this.instanceManager.hibernate(instanceId);
		} else {
			await this.instanceManager.destroy(instanceId);
		}
		if (this.poolManager) {
			this.poolManager.replenish(workloadId).catch(() => {});
		}

		// Delete the claim — tenant identity persists
		this.db.delete(claims).where(eq(claims.claimId, claim.claimId)).run();

		this.audit.tenantReleased(tenantId, instanceId, workloadId, usageSeconds);
	}

	// ── Private: claim orchestration ────────────────────────────────────────

	private async claimInner(tenantId: TenantId, workloadId: WorkloadId): Promise<ClaimResult> {
		const start = performance.now();

		// 1. Fast path — return existing active claim
		const existing = await this.tryExistingClaim(tenantId, workloadId, start);
		if (existing) return existing;

		// 2. Reserve a claim slot (upsert tenant, cleanup hibernated, insert claim row)
		const claimId = this.prepareNewClaim(tenantId, workloadId);

		try {
			// 3. Resolve an instance (pool or cold boot)
			const resolved = await this.resolveInstance(tenantId, workloadId);

			// 4. Finalize: activate claim, update activity, start idle watch
			return this.finalizeClaim(claimId, tenantId, workloadId, resolved, start);
		} catch (err) {
			this.db.delete(claims).where(eq(claims.claimId, claimId)).run();
			throw err;
		}
	}

	/**
	 * Returns an existing active claim if the tenant already has one.
	 * Cleans up stale claims where the instance has been destroyed.
	 */
	private async tryExistingClaim(
		tenantId: TenantId,
		workloadId: WorkloadId,
		start: number,
	): Promise<ClaimResult | null> {
		const existingClaim = this.db.select().from(claims)
			.where(and(eq(claims.tenantId, tenantId), eq(claims.workloadId, workloadId))).get();

		if (!existingClaim) return null;

		if (existingClaim.status === "creating" || existingClaim.status === "releasing") {
			throw new InvalidTransitionError("claim", existingClaim.status, "created");
		}

		if (existingClaim.status !== "active" || !existingClaim.instanceId) return null;

		// Verify the instance is actually running
		const instanceRow = this.db.select({ status: instances.status })
			.from(instances)
			.where(eq(instances.instanceId, existingClaim.instanceId))
			.get();

		if (instanceRow?.status === "active" || instanceRow?.status === "starting") {
			const handle = instanceHandleFrom(existingClaim.instanceId, instanceRow.status);
			const endpoint = await this.safeGetEndpoint(handle);
			this.startIdleWatch(existingClaim.instanceId, workloadId);
			const now = new Date();
			this.db.update(instances).set({ lastActivity: now }).where(eq(instances.instanceId, existingClaim.instanceId)).run();
			this.db.update(tenants).set({ lastActivity: now }).where(and(eq(tenants.tenantId, tenantId), eq(tenants.workloadId, workloadId))).run();
			return {
				tenantId,
				instanceId: existingClaim.instanceId,
				endpoint,
				source: "existing",
				latencyMs: performance.now() - start,
			};
		}

		// Instance is gone — delete stale claim
		this.db.delete(claims).where(eq(claims.claimId, existingClaim.claimId)).run();
		return null;
	}

	/**
	 * Upserts the tenant identity row, cleans up hibernated instances,
	 * and reserves a claim slot. Returns the new claim ID.
	 */
	private prepareNewClaim(tenantId: TenantId, workloadId: WorkloadId): ClaimId {
		this.upsertTenantIdentity(tenantId, workloadId);

		// Clean up hibernated instances (overlay data persisted to storage during release)
		const hibernated = this.db
			.select({ instanceId: instances.instanceId })
			.from(instances)
			.where(
				and(
					eq(instances.tenantId, tenantId),
					eq(instances.workloadId, workloadId),
					eq(instances.status, "hibernated"),
				),
			)
			.all();
		for (const row of hibernated) {
			this.db
				.update(instances)
				.set({ status: "destroyed" })
				.where(eq(instances.instanceId, row.instanceId))
				.run();
		}

		// Reserve claim slot (UNIQUE on tenantId+workloadId prevents races)
		const claimId = generateClaimId();
		this.db.insert(claims).values({ claimId, tenantId, workloadId, status: "creating", createdAt: new Date() }).run();
		return claimId;
	}

	/**
	 * Acquires an instance via pool (if available and no overlay) or cold boot.
	 */
	private async resolveInstance(
		tenantId: TenantId,
		workloadId: WorkloadId,
	): Promise<{ handle: InstanceHandle; source: ClaimSource }> {
		// Pool path — skip when tenant has overlay data (needs pre-start injection)
		if (this.poolManager && !(await this.tenantDataStore.hasOverlay(tenantId, workloadId))) {
			const instance = await this.poolManager.acquire(workloadId);
			await this.tenantDataStore.injectOverlay(instance, tenantId, workloadId);
			this.updateInstanceClaimed(instance.instanceId, tenantId);
			this.db.update(instances).set({ poolStatus: null }).where(eq(instances.instanceId, instance.instanceId)).run();
			this.poolManager.replenish(workloadId).catch(() => {});
			return { handle: instance, source: "pool" };
		}

		// Cold boot fallback
		const result = await this.createViaColdBoot(tenantId, workloadId);
		return { handle: result, source: result.source };
	}

	/**
	 * Activates the claim, updates activity timestamps, logs the event,
	 * and starts idle monitoring.
	 */
	private async finalizeClaim(
		claimId: ClaimId,
		tenantId: TenantId,
		workloadId: WorkloadId,
		resolved: { handle: InstanceHandle; source: ClaimSource },
		start: number,
	): Promise<ClaimResult> {
		const { handle, source } = resolved;
		this.db.update(claims).set({ instanceId: handle.instanceId, status: "active" }).where(eq(claims.claimId, claimId)).run();
		this.db.update(tenants).set({ lastActivity: new Date() }).where(eq(tenants.tenantId, tenantId)).run();

		const endpoint = await this.safeGetEndpoint(handle);
		const latencyMs = performance.now() - start;

		this.logClaim(tenantId, handle.instanceId, workloadId, source, latencyMs);
		this.startIdleWatch(handle.instanceId, workloadId);

		return { tenantId, instanceId: handle.instanceId, endpoint, source, latencyMs };
	}

	// ── Private: instance creation ──────────────────────────────────────────

	/** Cold boot: create a fresh instance from the workload definition. */
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

		const overlayPath = tenantRow
			? await this.tenantDataStore.restoreOverlay(tenantId, workloadId)
			: null;

		const source: ClaimSource = overlayPath ? "cold+data" : "cold";
		this.log?.info({ tenantId, workloadId, source }, `Claiming via ${source}`);

		const handle = await this.instanceManager.create(
			workloadId,
			workloadRow.config as Workload,
			tenantId,
			{ overlayArchivePath: overlayPath ?? undefined },
		);

		this.updateInstanceClaimed(handle.instanceId, tenantId);

		return { ...handle, source };
	}

	// ── Private: helpers ────────────────────────────────────────────────────

	/** Returns the endpoint, or null for containers with no exposed ports. */
	private async safeGetEndpoint(handle: InstanceHandle): Promise<Endpoint | null> {
		const endpoint = await this.instanceManager.getEndpoint(handle);
		if (endpoint.ports.length === 0) return null;
		return endpoint;
	}

	/** Inserts the tenant identity row if it doesn't exist. */
	private upsertTenantIdentity(tenantId: TenantId, workloadId: WorkloadId): void {
		const existing = this.db
			.select()
			.from(tenants)
			.where(and(eq(tenants.tenantId, tenantId), eq(tenants.workloadId, workloadId)))
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

	/** Sets tenantId, claimedAt and lastActivity on the instance row. */
	private updateInstanceClaimed(instanceId: InstanceId, tenantId: TenantId): void {
		const now = new Date();
		this.db
			.update(instances)
			.set({ tenantId, claimedAt: now, lastActivity: now })
			.where(eq(instances.instanceId, instanceId))
			.run();
	}

	/** Logs a tenant.claimed event. */
	private logClaim(
		tenantId: TenantId,
		instanceId: InstanceId,
		workloadId: WorkloadId,
		source: ClaimSource,
		durationMs?: number,
	): void {
		this.audit.tenantClaimed(tenantId, instanceId, workloadId, source, durationMs);
	}

	/** Starts idle monitoring for a newly claimed instance. */
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
