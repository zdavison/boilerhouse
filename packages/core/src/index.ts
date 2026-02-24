// @boilerhouse/core — domain types, workload parsing, shared logic

export {
	type InstanceId,
	type TenantId,
	type WorkloadId,
	type NodeId,
	type SnapshotId,
	InstanceIdSchema,
	TenantIdSchema,
	WorkloadIdSchema,
	NodeIdSchema,
	SnapshotIdSchema,
	generateInstanceId,
	generateTenantId,
	generateWorkloadId,
	generateNodeId,
	generateSnapshotId,
} from "./types";

export {
	InvalidTransitionError,
	createMachine,
	type TransitionMap,
	type Guard,
	type MachineConfig,
	type Machine,
} from "./state-machine";

export {
	type InstanceStatus,
	type InstanceEvent,
	InstanceStatusSchema,
	InstanceEventSchema,
	INSTANCE_STATUSES,
	INSTANCE_EVENTS,
	transition,
	canTransition,
} from "./instance-state";

export {
	type Workload,
	type NetworkAccess,
	type IdleAction,
	type PortExpose,
	type BindMount,
	type HttpGetProbe,
	type ExecProbe,
	WorkloadSchema,
	parseWorkload,
	WorkloadParseError,
} from "./workload";

export {
	type SnapshotType,
	type SnapshotRef,
	type SnapshotPaths,
	type SnapshotMetadata,
	SnapshotTypeSchema,
	SnapshotRefSchema,
	SnapshotPathsSchema,
	SnapshotMetadataSchema,
	createSnapshotRef,
	isGoldenSnapshot,
	isTenantSnapshot,
} from "./snapshot";

export {
	type NodeStatus,
	type NodeCapacity,
	type RuntimeType,
	type NodeEvent,
	NodeStatusSchema,
	NodeCapacitySchema,
	RuntimeTypeSchema,
	NodeEventSchema,
	NODE_STATUSES,
	NODE_EVENTS,
	RUNTIME_TYPES,
	validateNodeCapacity,
	NodeCapacityError,
	nodeTransition,
} from "./node";

export {
	type Runtime,
	type InstanceHandle,
	type Endpoint,
	type ExecResult,
	InstanceHandleSchema,
	EndpointSchema,
} from "./runtime";

export { FakeRuntime, type FakeRuntimeOptions } from "./fake-runtime";

export {
	type TenantStatus,
	type TenantEvent,
	TenantStatusSchema,
	TenantEventSchema,
	TENANT_STATUSES,
	TENANT_EVENTS,
	tenantTransition,
	canTenantTransition,
} from "./tenant-state";

export {
	type SnapshotStatus,
	type SnapshotEvent,
	SnapshotStatusSchema,
	SnapshotEventSchema,
	SNAPSHOT_STATUSES,
	SNAPSHOT_EVENTS,
	snapshotTransition,
	canSnapshotTransition,
} from "./snapshot-state";

export {
	type WorkloadStatus,
	type WorkloadEvent,
	WorkloadStatusSchema,
	WorkloadEventSchema,
	WORKLOAD_STATUSES,
	WORKLOAD_EVENTS,
	workloadTransition,
	canWorkloadTransition,
} from "./workload-state";
