import type { NodeId, Runtime } from "@boilerhouse/core";
import type { DrizzleDb, ActivityLog } from "@boilerhouse/db";
import type { Logger, Tracer, Meter } from "@boilerhouse/o11y";
import type { InstanceManager } from "../instance-manager";
import type { TenantManager } from "../tenant-manager";
import type { EventBus } from "../event-bus";
import type { ResourceLimiter } from "../resource-limits";
import type { BootstrapLogStore } from "../bootstrap-log-store";
import type { SecretStore } from "../secret-store";
import type { PoolManager } from "../pool-manager";

export interface RouteDeps {
	db: DrizzleDb;
	runtime: Runtime;
	nodeId: NodeId;
	activityLog: ActivityLog;
	instanceManager: InstanceManager;
	tenantManager: TenantManager;
	eventBus: EventBus;
	bootstrapLogStore: BootstrapLogStore;
	resourceLimiter?: ResourceLimiter;
	secretStore: SecretStore;
	poolManager?: PoolManager;
	apiKey?: string;
	log?: Logger;
	tracer?: Tracer;
	meter?: Meter;
}
