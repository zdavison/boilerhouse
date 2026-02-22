import { eq, and } from "drizzle-orm";
import type {
	InstanceId,
	WorkloadId,
	NodeId,
	TenantId,
	SnapshotId,
	SnapshotRef,
	Endpoint,
	TenantStatus,
} from "@boilerhouse/core";
import type { DrizzleDb, ActivityLog } from "@boilerhouse/db";
import { instances, snapshots, tenants, workloads, snapshotRefFrom } from "@boilerhouse/db";
import { applyTenantTransition } from "./transitions";
import { instanceHandleFrom } from "./instance-manager";
import type { InstanceManager } from "./instance-manager";
import type { SnapshotManager } from "./snapshot-manager";
import type { TenantDataStore } from "./tenant-data";
import type { IdleMonitor } from "./idle-monitor";

export type ClaimSource = "existing" | "snapshot" | "cold+data" | "golden";

export interface ClaimResult {
	tenantId: TenantId;
	instanceId: InstanceId;
	endpoint: Endpoint;
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
	constructor(
		private readonly instanceManager: InstanceManager,
		private readonly snapshotManager: SnapshotManager,
		private readonly db: DrizzleDb,
		private readonly activityLog: ActivityLog,
		private readonly nodeId: NodeId,
		private readonly tenantDataStore: TenantDataStore,
		private readonly idleMonitor?: IdleMonitor,
	) {}

	/**
	 * Claims an instance for the given tenant, following the restore hierarchy:
	 * 1. Existing active instance
	 * 2. Tenant snapshot (hot restore)
	 * 3. Golden + data overlay (cold restore with data)
	 * 4. Golden snapshot (fresh)
	 */
	async claim(tenantId: TenantId, workloadId: WorkloadId): Promise<ClaimResult> {
		const start = performance.now();

		// 1. Check for existing active instance
		const existingInstance = this.db
			.select()
			.from(instances)
			.where(
				and(
					eq(instances.tenantId, tenantId),
					eq(instances.status, "active"),
				),
			)
			.get();

		if (existingInstance) {
			const handle = instanceHandleFrom(existingInstance.instanceId, existingInstance.status);
			const endpoint = await this.instanceManager.getEndpoint(handle);

			return {
				tenantId,
				instanceId: existingInstance.instanceId,
				endpoint,
				source: "existing",
				latencyMs: performance.now() - start,
			};
		}

		// 2. Check for tenant snapshot
		const tenantRow = this.db
			.select()
			.from(tenants)
			.where(eq(tenants.tenantId, tenantId))
			.get();

		if (tenantRow?.lastSnapshotId) {
			const snapshotRef = this.getSnapshotRef(tenantRow.lastSnapshotId);
			if (snapshotRef) {
				return this.restoreAndClaim(snapshotRef, tenantId, workloadId, "snapshot", start);
			}
		}

		// 3. Check for data overlay (cold+data path)
		const overlayPath = tenantRow
			? this.tenantDataStore.restoreOverlay(tenantId)
			: null;

		if (overlayPath) {
			const goldenRef = this.snapshotManager.getGolden(workloadId, this.nodeId);
			if (!goldenRef) {
				throw new NoGoldenSnapshotError(workloadId, this.nodeId);
			}

			return this.restoreAndClaim(goldenRef, tenantId, workloadId, "cold+data", start);
		}

		// 4. Fresh from golden
		const goldenRef = this.snapshotManager.getGolden(workloadId, this.nodeId);
		if (!goldenRef) {
			throw new NoGoldenSnapshotError(workloadId, this.nodeId);
		}

		return this.restoreAndClaim(goldenRef, tenantId, workloadId, "golden", start);
	}

	/**
	 * Releases a tenant's instance according to the workload's idle policy.
	 * Hibernate saves a snapshot; destroy removes the instance entirely.
	 * No-op if the tenant has no active instance.
	 */
	async release(tenantId: TenantId): Promise<void> {
		const tenantRow = this.db
			.select()
			.from(tenants)
			.where(eq(tenants.tenantId, tenantId))
			.get();

		if (!tenantRow?.instanceId) return;

		const instanceId = tenantRow.instanceId;

		const tenantStatus = tenantRow.status as TenantStatus;
		applyTenantTransition(this.db, tenantId, tenantStatus, "release");

		if (this.idleMonitor) {
			this.idleMonitor.unwatch(instanceId);
		}

		// Look up the workload config to determine idle action
		const workloadRow = this.db
			.select()
			.from(workloads)
			.where(eq(workloads.workloadId, tenantRow.workloadId))
			.get();

		const idleAction = workloadRow?.config?.idle?.action ?? "hibernate";

		if (idleAction === "hibernate") {
			await this.instanceManager.hibernate(instanceId);
			applyTenantTransition(this.db, tenantId, "releasing", "hibernated");
		} else {
			await this.instanceManager.destroy(instanceId);
			applyTenantTransition(this.db, tenantId, "releasing", "destroyed");
		}

		// Clear instanceId on tenant row (lastSnapshotId is preserved by hibernate)
		this.db
			.update(tenants)
			.set({ instanceId: null })
			.where(eq(tenants.tenantId, tenantId))
			.run();

		this.activityLog.log({
			event: "tenant.released",
			tenantId,
			instanceId,
			workloadId: tenantRow.workloadId,
			nodeId: this.nodeId,
		});
	}

	private async restoreAndClaim(
		ref: SnapshotRef,
		tenantId: TenantId,
		workloadId: WorkloadId,
		source: ClaimSource,
		start: number,
	): Promise<ClaimResult> {
		const handle = await this.instanceManager.restoreFromSnapshot(ref, tenantId);

		this.upsertTenant(tenantId, workloadId, handle.instanceId);
		this.updateInstanceClaimed(handle.instanceId);

		const endpoint = await this.instanceManager.getEndpoint(handle);

		this.logClaim(tenantId, handle.instanceId, workloadId, source);
		this.startIdleWatch(handle.instanceId, workloadId);

		return {
			tenantId,
			instanceId: handle.instanceId,
			endpoint,
			source,
			latencyMs: performance.now() - start,
		};
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
	 * Inserts or updates the tenant row with the current instance.
	 * Transitions tenant status through claiming → active.
	 */
	private upsertTenant(
		tenantId: TenantId,
		workloadId: WorkloadId,
		instanceId: InstanceId,
	): void {
		const existing = this.db
			.select()
			.from(tenants)
			.where(eq(tenants.tenantId, tenantId))
			.get();

		if (existing) {
			applyTenantTransition(this.db, tenantId, existing.status as TenantStatus, "claim");
			applyTenantTransition(this.db, tenantId, "claiming", "claimed");

			this.db
				.update(tenants)
				.set({ instanceId, lastActivity: new Date() })
				.where(eq(tenants.tenantId, tenantId))
				.run();
		} else {
			// New tenant: insert directly as "active" (claim + claimed in one step)
			this.db
				.insert(tenants)
				.values({
					tenantId,
					workloadId,
					instanceId,
					status: "active" as TenantStatus,
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
	}
}
