// @boilerhouse/db — database schema + migrations

export { timestamp, jsonObject } from "./columns";

export {
	nodes,
	workloads,
	instances,
	snapshots,
	tenants,
	claims,
	activityLog,
	buildLogs,
	schema,
	type NodeRow,
	type NodeInsert,
	type WorkloadRow,
	type WorkloadInsert,
	type InstanceRow,
	type InstanceInsert,
	type SnapshotRow,
	type SnapshotInsert,
	type TenantRow,
	type TenantInsert,
	type ClaimRow,
	type ClaimInsert,
	type ActivityLogRow,
	type ActivityLogInsert,
	type BuildLogRow,
	type BuildLogInsert,
	tenantSecrets,
	type TenantSecretRow,
	type TenantSecretInsert,
	triggers,
	type TriggerRow,
	type TriggerInsert,
} from "./schema";

export {
	initDatabase,
	createTestDatabase,
	type DrizzleDb,
} from "./database";

export { ActivityLog } from "./activity-log";

export { snapshotRefFrom } from "./snapshot-helpers";

export {
	loadWorkloadsFromDir,
	type WorkloadLoaderResult,
} from "./workload-loader";

export {
	loadTriggersFromDir,
	type TriggerLoaderResult,
} from "./trigger-loader";
