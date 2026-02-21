import { EventEmitter } from "node:events";
import type {
	InstanceId,
	TenantId,
	WorkloadId,
	InstanceStatus,
	WorkloadStatus,
} from "@boilerhouse/core";
import type { ClaimSource } from "./tenant-manager";

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
}

export interface TenantReleaseEvent {
	type: "tenant.released";
	tenantId: TenantId;
	instanceId: InstanceId;
}

export interface WorkloadStateEvent {
	type: "workload.state";
	workloadId: WorkloadId;
	status: WorkloadStatus;
}

export type DomainEvent =
	| InstanceStateEvent
	| TenantClaimEvent
	| TenantReleaseEvent
	| WorkloadStateEvent;

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
