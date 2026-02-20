import type { NodeId, Runtime } from "@boilerhouse/core";
import type { DrizzleDb, ActivityLog } from "@boilerhouse/db";
import type { InstanceManager } from "../instance-manager";
import type { TenantManager } from "../tenant-manager";
import type { SnapshotManager } from "../snapshot-manager";
import type { EventBus } from "../event-bus";
import type { ResourceLimiter } from "../resource-limits";

export interface RouteDeps {
	db: DrizzleDb;
	runtime: Runtime;
	nodeId: NodeId;
	activityLog: ActivityLog;
	instanceManager: InstanceManager;
	tenantManager: TenantManager;
	snapshotManager: SnapshotManager;
	eventBus: EventBus;
	resourceLimiter?: ResourceLimiter;
}
