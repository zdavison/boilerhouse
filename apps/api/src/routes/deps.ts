import type { NodeId, Runtime } from "@boilerhouse/core";
import type { DrizzleDb, ActivityLog } from "@boilerhouse/db";
import type { Logger, Tracer, Meter } from "@boilerhouse/o11y";
import type { InstanceManager } from "@boilerhouse/domain";
import type { TenantManager } from "@boilerhouse/domain";
import type { EventBus } from "@boilerhouse/domain";
import type { ResourceLimiter } from "../resource-limits";
import type { BootstrapLogStore } from "@boilerhouse/domain";
import type { SecretStore } from "../secret-store";
import type { PoolManager } from "@boilerhouse/domain";

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
