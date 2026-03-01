import type { NodeId, Runtime } from "@boilerhouse/core";
import type { DrizzleDb, ActivityLog } from "@boilerhouse/db";
import type { Logger } from "@boilerhouse/logger";
import type { InstanceManager } from "../instance-manager";
import type { TenantManager } from "../tenant-manager";
import type { SnapshotManager } from "../snapshot-manager";
import type { EventBus } from "../event-bus";
import type { ResourceLimiter } from "../resource-limits";
import type { GoldenCreator } from "../golden-creator";
import type { BootstrapLogStore } from "../bootstrap-log-store";

export interface RouteDeps {
	db: DrizzleDb;
	runtime: Runtime;
	nodeId: NodeId;
	activityLog: ActivityLog;
	instanceManager: InstanceManager;
	tenantManager: TenantManager;
	snapshotManager: SnapshotManager;
	eventBus: EventBus;
	goldenCreator: GoldenCreator;
	bootstrapLogStore: BootstrapLogStore;
	resourceLimiter?: ResourceLimiter;
	log?: Logger;
}
