import { eq, and } from "drizzle-orm";
import type {
	InstanceId,
	InstanceHandle,
	WorkloadId,
	NodeId,
	TenantId,
	SnapshotId,
	SnapshotRef,
	Endpoint,
	ClaimStatus,
	Workload,
} from "@boilerhouse/core";
import {
	generateClaimId,
	InvalidTransitionError,
} from "@boilerhouse/core";
import type { DrizzleDb, ActivityLog } from "@boilerhouse/db";
import { instances, snapshots, tenants, workloads, claims, snapshotRefFrom } from "@boilerhouse/db";
import type { Logger } from "@boilerhouse/o11y";
import { applyClaimTransition } from "./transitions";
import { instanceHandleFrom } from "./instance-manager";
import type { InstanceManager } from "./instance-manager";
import type { SnapshotManager } from "./snapshot-manager";
import type { TenantDataStore } from "./tenant-data";
import type { IdleMonitor } from "./idle-monitor";
import type { WatchDirsPoller } from "./watch-dirs-poller";
import type { EventBus } from "./event-bus";

export type ClaimSource = "existing" | "snapshot" | "cold+data" | "golden" | "cold";

export interface ClaimResult {
	tenantId: TenantId;
	instanceId: InstanceId;
	endpoint: Endpoint | null;
	source: ClaimSource;
	latencyMs: number;
}

export class NoGoldenSnapshotError extends Error {
	constructor(workloadId: WorkloadId, nodeId: NodeId) {
		super(
			`No golden snapshot found for workload ${workloadId} on node ${nodeId}`,
		);
		this.name = "NoGoldenSnapshotError";
	}
}

export class TenantManager {
	/** Per-tenant+workload lock to prevent duplicate claims from concurrent requests. */
	private readonly inflightClaims = new Map<string, Promise<ClaimResult>>();
	/**
	 * Per-snapshot mutex for CRIU restores.
	 * CRIU cannot restore the same checkpoint archive concurrently —
	 * concurrent restores from the same golden snapshot must be serialized.
	 */
	private readonly restoreLocks = new Map<string, Promise<void>>();

	constructor(
		private readonly instanceManager: InstanceManager,
		private readonly snapshotManager: SnapshotManager,
		private readonly db: DrizzleDb,
		private readonly activityLog: ActivityLog,
		private readonly nodeId: NodeId,
		private readonly tenantDataStore: TenantDataStore,
		private readonly idleMonitor?: IdleMonitor,
		private readonly log?: Logger,
		private readonly eventBus?: EventBus,
		private readonly watchDirsPoller?: WatchDirsPoller,
	) {}

	/**
	 * Claims an instance for the given tenant.
	 *
	 * The claim row acts as a concurrency guard via UNIQUE constraint on tenantId.
	 *
	 * When the runtime supports golden snapshots, follows the restore hierarchy:
	 * 1. Existing active claim
	 * 2. Tenant snapshot (hot restore)
	 * 3. Golden + data overlay (cold restore with data)
	 * 4. Golden snapshot (fresh)
	 *
	 * When golden snapshots are not supported:
	 * 1. Existing active claim
	 * 2. Tenant snapshot (restore)
	 * 3. Cold boot from workload definition
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
			// Verify the instance is actually running (it may have been hibernated/destroyed directly)
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

			// Instance is gone/hibernated — delete stale claim and proceed
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
			// 4. Get or create the instance (same restore hierarchy as before)
			const handle = await this.createInstance(tenantId, workloadId);

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
	 * Releases a tenant's instance according to the workload's idle policy.
	 *
	 * When `idle.action` is `"hibernate"`, the runtime snapshots the instance
	 * (CRIU checkpoint on Podman, overlay tar on Kubernetes) and the tenant
	 * can be restored from it on re-claim. When `"destroy"`, the instance is
	 * removed entirely.
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

		// Look up the workload config to determine idle action
		const workloadRow = this.db
			.select()
			.from(workloads)
			.where(eq(workloads.workloadId, tenantRow.workloadId))
			.get();

		const idleAction = workloadRow?.config?.idle?.action ?? "hibernate";

		// Save overlay data from the running container before hibernate/destroy
		const workloadConfig = workloadRow?.config as Workload | undefined;
		const overlayDirs = workloadConfig?.filesystem?.overlay_dirs;
		if (overlayDirs?.length) {
			const overlayData = await this.instanceManager.extractOverlay(instanceId, overlayDirs);
			if (overlayData) {
				this.tenantDataStore.saveOverlayBuffer(tenantId, tenantRow.workloadId, overlayData);
				this.log?.info({ tenantId, workloadId: tenantRow.workloadId }, "Saved overlay data for tenant");
			}
		}

		if (idleAction === "hibernate") {
			// hibernate() also updates tenant.lastSnapshotId and deletes the old snapshot
			await this.instanceManager.hibernate(instanceId);
		} else {
			await this.instanceManager.destroy(instanceId);
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

	/** Creates an instance via the restore hierarchy and returns handle with source. */
	private async createInstance(
		tenantId: TenantId,
		workloadId: WorkloadId,
	): Promise<InstanceHandle & { source: ClaimSource }> {
		// Check for tenant snapshot
		const tenantRow = this.db
			.select()
			.from(tenants)
			.where(and(eq(tenants.tenantId, tenantId), eq(tenants.workloadId, workloadId)))
			.get();

		if (tenantRow?.lastSnapshotId) {
			const snapshotRef = this.getSnapshotRef(tenantRow.lastSnapshotId);
			if (snapshotRef) {
				this.log?.info({ tenantId, workloadId, source: "snapshot", snapshotId: snapshotRef.id }, "Claiming via tenant snapshot");
				const handle = await this.restoreInstance(snapshotRef, tenantId);
				this.updateInstanceClaimed(handle.instanceId);
				return { ...handle, source: "snapshot" };
			}
		}

		if (this.snapshotManager.capabilities.goldenSnapshots) {
			return this.createViaGolden(tenantId, workloadId, tenantRow);
		}

		return this.createViaColdBoot(tenantId, workloadId, tenantRow);
	}

	/** Golden snapshot create path (steps 3–4): overlay restore or fresh golden. */
	private async createViaGolden(
		tenantId: TenantId,
		workloadId: WorkloadId,
		tenantRow: { tenantId: TenantId } | undefined,
	): Promise<InstanceHandle & { source: ClaimSource }> {
		// Check for data overlay (cold+data path)
		const overlayPath = tenantRow
			? this.tenantDataStore.restoreOverlay(tenantId, workloadId)
			: null;

		if (overlayPath) {
			const goldenRef = this.snapshotManager.getGolden(workloadId, this.nodeId);
			if (!goldenRef) {
				throw new NoGoldenSnapshotError(workloadId, this.nodeId);
			}

			this.log?.info({ tenantId, workloadId, source: "cold+data", snapshotId: goldenRef.id }, "Claiming via golden + data overlay");
			const handle = await this.restoreInstance(goldenRef, tenantId);
			this.updateInstanceClaimed(handle.instanceId);
			await this.instanceManager.injectOverlay(handle.instanceId, overlayPath);
			return { ...handle, source: "cold+data" };
		}

		// Fresh from golden
		const goldenRef = this.snapshotManager.getGolden(workloadId, this.nodeId);
		if (!goldenRef) {
			throw new NoGoldenSnapshotError(workloadId, this.nodeId);
		}

		this.log?.info({ tenantId, workloadId, source: "golden", snapshotId: goldenRef.id }, "Claiming via golden snapshot");
		const handle = await this.restoreInstance(goldenRef, tenantId);
		this.updateInstanceClaimed(handle.instanceId);
		return { ...handle, source: "golden" };
	}

	/** Cold boot create path: create a fresh instance from the workload definition. */
	private async createViaColdBoot(
		tenantId: TenantId,
		workloadId: WorkloadId,
		tenantRow: { tenantId: TenantId } | undefined,
	): Promise<InstanceHandle & { source: ClaimSource }> {
		const workloadRow = this.db
			.select()
			.from(workloads)
			.where(eq(workloads.workloadId, workloadId))
			.get();

		if (!workloadRow) {
			throw new Error(`Workload not found: ${workloadId}`);
		}

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

	/** Restores an instance from a snapshot reference. */
	private async restoreInstance(
		ref: SnapshotRef,
		tenantId: TenantId,
	): Promise<InstanceHandle> {
		this.eventBus?.emit({
			type: "tenant.claiming",
			tenantId,
			workloadId: ref.workloadId,
			source: "snapshot",
			snapshotId: ref.id,
		});

		const prepared = this.instanceManager.prepareRestore(ref, tenantId);
		let handle: InstanceHandle;
		try {
			handle = await this.serializedRestore(ref.id, () =>
				this.instanceManager.executeRestore(ref, prepared.instanceId, prepared.workloadId, tenantId),
			);
		} catch (err) {
			this.log?.error(
				{ tenantId, workloadId: ref.workloadId, snapshotId: ref.id, err },
				"Restore failed during claim",
			);
			throw err;
		}

		return handle;
	}

	/**
	 * Serializes restore operations that share the same snapshot.
	 * CRIU cannot restore the same checkpoint archive concurrently, and
	 * needs a brief cooldown between restores for overlay cleanup.
	 */
	private async serializedRestore<T>(snapshotId: string, fn: () => Promise<T>): Promise<T> {
		const tail = this.restoreLocks.get(snapshotId) ?? Promise.resolve();

		let resolve!: () => void;
		const next = new Promise<void>((r) => { resolve = r; });
		this.restoreLocks.set(snapshotId, next);

		// Wait for all prior restores of this snapshot to finish
		await tail.catch(() => {});

		try {
			return await fn();
		} catch (err) {
			// Brief cooldown after failure — CRIU overlay cleanup is async
			await new Promise((r) => setTimeout(r, 500));
			throw err;
		} finally {
			resolve();
			if (this.restoreLocks.get(snapshotId) === next) {
				this.restoreLocks.delete(snapshotId);
			}
		}
	}

	/** Returns the endpoint, or null for containers with no exposed ports. */
	private async safeGetEndpoint(handle: InstanceHandle): Promise<Endpoint | null> {
		const endpoint = await this.instanceManager.getEndpoint(handle);
		if (endpoint.ports.length === 0) return null;
		return endpoint;
	}

	private getSnapshotRef(snapshotId: SnapshotId): SnapshotRef | null {
		const row = this.db
			.select()
			.from(snapshots)
			.where(eq(snapshots.snapshotId, snapshotId))
			.get();

		if (!row) return null;

		return snapshotRefFrom(row);
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
