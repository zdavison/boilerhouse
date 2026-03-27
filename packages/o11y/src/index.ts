// Logger (moved from @boilerhouse/logger)
export { createLogger } from "./logger";
export type { Logger } from "./logger";

// OTEL provider setup
export { initO11y } from "./provider";
export type { InitOptions, O11yProviders } from "./provider";

// Re-export OTEL types so consumers don't need @opentelemetry/api directly
export type { Tracer, Meter } from "@opentelemetry/api";

// Metrics instrumentation
export { instrumentTenants } from "./metrics/tenants";
export type { TenantMetrics, TenantMetricsDeps } from "./metrics/tenants";
export { instrumentInstances } from "./metrics/instances";
export type { InstanceMetrics, InstanceMetricsDeps } from "./metrics/instances";
export { instrumentSnapshots } from "./metrics/snapshots";
export type { SnapshotMetrics, SnapshotMetricsDeps } from "./metrics/snapshots";
export { instrumentCapacity } from "./metrics/capacity";
export type { CapacityMetrics, CapacityMetricsDeps } from "./metrics/capacity";
export { instrumentPool } from "./metrics/pool";
export type { PoolMetrics, PoolMetricsDeps } from "./metrics/pool";
export { instrumentTriggers } from "./metrics/triggers";
export type { TriggerMetrics } from "./metrics/triggers";
export { instrumentWebSocket } from "./metrics/websocket";
export type { WebSocketMetrics } from "./metrics/websocket";
export { instrumentHealthCheck } from "./metrics/healthcheck";
export type { HealthCheckMetrics } from "./metrics/healthcheck";
export { instrumentNode } from "./metrics/node";
export type { NodeMetrics, ContainerSnapshot } from "./metrics/node";

// Unified EventBus → metrics wiring
export { instrumentFromEventBus } from "./instrument";
export type { InstrumentDeps, AllMetrics, ContainerStatsProvider } from "./instrument";

// Tracing — manager wrappers
export { wrapTenantManager } from "./tracing/tenants";
export { wrapInstanceManager } from "./tracing/instances";

// Tracing — HTTP plugin
export { httpTracing } from "./tracing/http";
