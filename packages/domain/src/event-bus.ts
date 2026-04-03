import { EventEmitter } from "node:events";
import type {
	InstanceId,
	TenantId,
	WorkloadId,
	InstanceStatus,
	WorkloadStatus,
	ClaimSource,
} from "@boilerhouse/core";

export interface InstanceStateEvent {
	type: "instance.state";
	instanceId: InstanceId;
	status: InstanceStatus;
	workloadId?: WorkloadId;
	tenantId?: TenantId;
}

export interface TenantClaimEvent {
	type: "tenant.claimed";
	tenantId: TenantId;
	instanceId: InstanceId;
	workloadId: WorkloadId;
	source: ClaimSource;
	lastActivity?: string;
	durationMs?: number;
}

export interface TenantReleaseEvent {
	type: "tenant.released";
	tenantId: TenantId;
	instanceId: InstanceId;
	workloadId?: WorkloadId;
	usageSeconds?: number;
}

export interface WorkloadStateEvent {
	type: "workload.state";
	workloadId: WorkloadId;
	status: WorkloadStatus;
}

export interface TenantClaimingEvent {
	type: "tenant.claiming";
	tenantId: TenantId;
	workloadId: WorkloadId;
	source: ClaimSource;
	snapshotId: string;
}

export interface BootstrapLogEvent {
	type: "bootstrap.log";
	workloadId: WorkloadId;
	line: string;
	timestamp: string;
}

export interface PoolInstanceReadyEvent {
	type: "pool.instance.ready";
	instanceId: InstanceId;
	workloadId: WorkloadId;
	durationSeconds: number;
}

export interface IdleTimeoutEvent {
	type: "idle.timeout";
	instanceId: InstanceId;
	tenantId: TenantId;
	action: string;
}

export interface TriggerDispatchedEvent {
	type: "trigger.dispatched";
	tenantId: TenantId;
	instanceId: InstanceId;
	triggerName: string;
	source: string;
	durationMs?: number;
}

export interface TriggerErrorEvent {
	type: "trigger.error";
	tenantId: TenantId;
	triggerName: string;
	reason: string;
}

export type DomainEvent =
	| InstanceStateEvent
	| TenantClaimEvent
	| TenantClaimingEvent
	| TenantReleaseEvent
	| WorkloadStateEvent
	| BootstrapLogEvent
	| PoolInstanceReadyEvent
	| IdleTimeoutEvent
	| TriggerDispatchedEvent
	| TriggerErrorEvent;

export class EventBus {
	private readonly emitter = new EventEmitter();

	emit(event: DomainEvent): void {
		this.emitter.emit("event", event);
	}

	on(handler: (event: DomainEvent) => void): void {
		this.emitter.on("event", handler);
	}

	off(handler: (event: DomainEvent) => void): void {
		this.emitter.off("event", handler);
	}

	listenerCount(): number {
		return this.emitter.listenerCount("event");
	}
}
