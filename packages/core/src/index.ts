// @boilerhouse/core — domain types, workload parsing, shared logic

export {
	type InstanceId,
	type TenantId,
	type WorkloadId,
	type NodeId,
	type SnapshotId,
	type TriggerId,
	type ClaimId,
	InstanceIdSchema,
	TenantIdSchema,
	WorkloadIdSchema,
	NodeIdSchema,
	SnapshotIdSchema,
	TriggerIdSchema,
	ClaimIdSchema,
	generateInstanceId,
	generateTenantId,
	generateWorkloadId,
	generateNodeId,
	generateSnapshotId,
	generateTriggerId,
	generateClaimId,
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
	type HttpGetProbe,
	type ExecProbe,
	type CredentialRule,
	type WorkloadConfig,
	type PoolConfig,
	type SecretRef,
	WorkloadSchema,
	validateWorkload,
	WorkloadParseError,
	defineWorkload,
	resolveWorkloadConfig,
	secret,
	isSecretRef,
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
	type CreateOptions,
	type ExecOptions,
	type InstanceHandle,
	type Endpoint,
	type ExecResult,
	type PoolStatus,
	InstanceHandleSchema,
	EndpointSchema,
} from "./runtime";

export { FakeRuntime, type FakeRuntimeOptions } from "./fake-runtime";

export {
	type ClaimStatus,
	type ClaimEvent,
	ClaimStatusSchema,
	ClaimEventSchema,
	CLAIM_STATUSES,
	CLAIM_EVENTS,
	claimTransition,
	canClaimTransition,
} from "./claim-state";

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
	DEFAULT_RUNTIME_SOCKET,
	DEFAULT_PODMAN_SOCKET,
	DEFAULT_SNAPSHOT_DIR,
} from "./paths";

export {
	encryptArchive,
	decryptArchive,
	isEncryptedArchive,
	ArchiveDecryptionError,
} from "./archive-crypto";

export { WorkQueue, type WorkQueueOptions } from "./work-queue";

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
