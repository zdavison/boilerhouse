// @boilerhouse/domain — shared managers for API and operator

export { type SecretResolver, type SecretRef } from "./secret-resolver";

// EventBus
export {
	EventBus,
	type DomainEvent,
	type InstanceStateEvent,
	type TenantClaimEvent,
	type TenantReleaseEvent,
	type WorkloadStateEvent,
	type TenantClaimingEvent,
	type BootstrapLogEvent,
	type PoolInstanceReadyEvent,
	type IdleTimeoutEvent,
	type TriggerDispatchedEvent,
	type TriggerErrorEvent,
} from "./event-bus";

// Transitions
export {
	applyInstanceTransition,
	forceInstanceStatus,
	applyClaimTransition,
	applySnapshotTransition,
	applyWorkloadTransition,
	instanceHandleFrom,
} from "./transitions";

// AuditLogger
export { AuditLogger } from "./audit-logger";

// HealthCheck
export {
	pollHealth,
	createHttpCheck,
	createExecCheck,
	HealthCheckTimeoutError,
	type HealthConfig,
	type HealthCheckFn,
	type HealthChecker,
} from "./health-check";

// IdleMonitor
export { IdleMonitor, type IdleConfig, type IdleHandler } from "./idle-monitor";

// BootstrapLogStore
export { BootstrapLogStore, type BootstrapLogEntry } from "./bootstrap-log-store";

// TenantDataStore
export { TenantDataStore, type TenantDataStoreOptions } from "./tenant-data";

// InstanceManager
export { InstanceManager, type ProxyConfigBuilder } from "./instance-manager";

// WatchDirsPoller
export { WatchDirsPoller } from "./watch-dirs-poller";

// PoolManager
export { PoolManager, type PoolManagerOptions } from "./pool-manager";

// TenantManager
export {
	TenantManager,
	type TenantManagerOptions,
	type ClaimSource,
	type ClaimResult,
} from "./tenant-manager";

// Recovery
export { recoverState, type RecoveryReport } from "./recovery";

// Test helpers
export { createTestAudit } from "./test-helpers";
