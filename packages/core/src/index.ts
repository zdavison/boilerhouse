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
	type InstanceStatus,
	type InstanceEvent,
	InstanceStatusSchema,
	InstanceEventSchema,
	INSTANCE_STATUSES,
	INSTANCE_EVENTS,
	transition,
	InvalidTransitionError,
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
	NodeStatusSchema,
	NodeCapacitySchema,
	RuntimeTypeSchema,
	NODE_STATUSES,
	RUNTIME_TYPES,
	validateNodeCapacity,
	NodeCapacityError,
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
