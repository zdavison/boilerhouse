/**
 * AuditLogger — unified facade over ActivityLog (persistent) and EventBus (real-time).
 *
 * Every business-logic event goes through this single entry point so the
 * persistent audit trail and real-time event stream never drift apart.
 */

import type {
	InstanceId,
	TenantId,
	WorkloadId,
	NodeId,
	ClaimSource,
	WorkloadStatus,
} from "@boilerhouse/core";
import type { ActivityLog } from "@boilerhouse/db";
import type { EventBus, DomainEvent } from "./event-bus";

export class AuditLogger {
	constructor(
		private readonly activityLog: ActivityLog,
		private readonly eventBus: EventBus,
		private readonly nodeId: NodeId,
	) {}

	// ── Instance events ──────────────────────────────────────────────────

	instanceStarting(instanceId: InstanceId, workloadId: WorkloadId, tenantId?: TenantId): void {
		this.log("instance.starting", { instanceId, workloadId, tenantId });
		this.emit({ type: "instance.state", instanceId, status: "starting", workloadId, tenantId });
	}

	instanceCreated(instanceId: InstanceId, workloadId: WorkloadId, durationMs: number, tenantId?: TenantId): void {
		this.log("instance.created", { instanceId, workloadId, tenantId }, { durationMs });
		this.emit({ type: "instance.state", instanceId, status: "started", workloadId, tenantId });
	}

	instanceDestroyed(instanceId: InstanceId, workloadId: WorkloadId, durationMs: number, tenantId?: TenantId): void {
		this.log("instance.destroyed", { instanceId, workloadId, tenantId }, { durationMs });
		this.emit({ type: "instance.state", instanceId, status: "destroyed", workloadId, tenantId });
	}

	instanceHibernated(instanceId: InstanceId, workloadId: WorkloadId, tenantId?: TenantId): void {
		this.log("instance.hibernated", { instanceId, workloadId, tenantId });
		this.emit({ type: "instance.state", instanceId, status: "hibernated", workloadId, tenantId });
	}

	instanceError(instanceId: InstanceId, workloadId: WorkloadId, reason: string, tenantId?: TenantId): void {
		this.log("instance.error", { instanceId, workloadId, tenantId }, { reason });
	}

	// ── Tenant events ────────────────────────────────────────────────────

	tenantClaimed(tenantId: TenantId, instanceId: InstanceId, workloadId: WorkloadId, source: ClaimSource, durationMs?: number): void {
		this.log("tenant.claimed", { tenantId, instanceId, workloadId }, { source, durationMs });
		this.emit({ type: "tenant.claimed", tenantId, instanceId, workloadId, source, durationMs });
	}

	tenantReleased(tenantId: TenantId, instanceId: InstanceId, workloadId: WorkloadId, usageSeconds?: number): void {
		this.log("tenant.released", { tenantId, instanceId, workloadId }, { usageSeconds });
		this.emit({ type: "tenant.released", tenantId, instanceId, workloadId, usageSeconds });
	}

	// ── Workload events ──────────────────────────────────────────────────

	workloadRegistered(workloadId: WorkloadId, name: string, status: WorkloadStatus): void {
		this.log("workload.registered", { workloadId }, { name, status });
		this.emit({ type: "workload.state", workloadId, status });
	}

	workloadReady(workloadId: WorkloadId, name: string): void {
		this.log("workload.ready", { workloadId }, { name });
		this.emit({ type: "workload.state", workloadId, status: "ready" });
	}

	workloadError(workloadId: WorkloadId, name: string, reason: string): void {
		this.log("workload.error", { workloadId }, { name, reason });
		this.emit({ type: "workload.state", workloadId, status: "error" });
	}

	// ── Pool events ──────────────────────────────────────────────────────

	poolInstanceReady(instanceId: InstanceId, workloadId: WorkloadId, durationSeconds: number): void {
		this.log("pool.instance.ready", { instanceId, workloadId }, { durationSeconds });
		this.emit({ type: "pool.instance.ready", instanceId, workloadId, durationSeconds });
	}

	poolAcquired(instanceId: InstanceId, workloadId: WorkloadId): void {
		this.log("pool.acquired", { instanceId, workloadId });
	}

	poolReplenishStarted(workloadId: WorkloadId): void {
		this.log("pool.replenish.started", { workloadId });
	}

	// ── Idle events ──────────────────────────────────────────────────────

	idleTimeout(instanceId: InstanceId, tenantId: TenantId, action: string): void {
		this.log("idle.timeout", { instanceId, tenantId }, { action });
		this.emit({ type: "idle.timeout", instanceId, tenantId, action });
	}

	// ── Recovery events ──────────────────────────────────────────────────

	recoveryComplete(recovered: number, destroyed: number, claimsReset: number): void {
		this.log("recovery.complete", {}, { recovered, destroyed, claimsReset });
	}

	// ── Snapshot events ──────────────────────────────────────────────────

	snapshotCreated(snapshotId: string, tenantId: TenantId, workloadId: WorkloadId): void {
		this.log("snapshot.created", { tenantId, workloadId }, { snapshotId });
	}

	snapshotDeleted(snapshotId: string): void {
		this.log("snapshot.deleted", {}, { snapshotId });
	}

	// ── Trigger events (pass-through for Dispatcher compatibility) ──────

	triggerInvoked(tenantId: TenantId, triggerName: string, workload: string): void {
		this.log("trigger.invoked", { tenantId }, { trigger: triggerName, workload });
	}

	triggerDispatched(tenantId: TenantId, instanceId: InstanceId, triggerName: string, source: string, durationMs?: number): void {
		this.log("trigger.dispatched", { tenantId, instanceId }, { trigger: triggerName, source, durationMs });
		this.emit({ type: "trigger.dispatched", tenantId, instanceId, triggerName, source, durationMs });
	}

	triggerError(tenantId: TenantId, instanceId: InstanceId | null, triggerName: string, phase: string, reason: string): void {
		this.log("trigger.error", { tenantId, instanceId: instanceId ?? undefined }, { trigger: triggerName, phase, reason });
		this.emit({ type: "trigger.error", tenantId, triggerName, reason });
	}

	// ── Bootstrap log (EventBus only, not persisted to activity_log) ────

	bootstrapLog(workloadId: WorkloadId, line: string): void {
		this.emit({ type: "bootstrap.log", workloadId, line, timestamp: new Date().toISOString() });
	}

	// ── Internal helpers ─────────────────────────────────────────────────

	private log(
		event: string,
		ids: {
			instanceId?: InstanceId;
			tenantId?: TenantId;
			workloadId?: WorkloadId;
		},
		metadata?: Record<string, unknown>,
	): void {
		this.activityLog.log({
			event,
			instanceId: ids.instanceId ?? null,
			tenantId: ids.tenantId ?? null,
			workloadId: ids.workloadId ?? null,
			nodeId: this.nodeId,
			metadata: metadata ?? null,
		});
	}

	private emit(event: DomainEvent): void {
		this.eventBus.emit(event);
	}
}
