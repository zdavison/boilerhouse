import {
	sqliteTable,
	text,
	integer,
	index,
	unique,
	primaryKey,
} from "drizzle-orm/sqlite-core";
import type {
	NodeId,
	NodeStatus,
	RuntimeType,
	NodeCapacity,
	WorkloadId,
	WorkloadStatus,
	Workload,
	InstanceId,
	TenantId,
	InstanceStatus,
	PoolStatus,
	SnapshotId,
	SnapshotType,
	SnapshotStatus,
	TriggerId,
	ClaimId,
	ClaimStatus,
} from "@boilerhouse/core";
import { timestamp, jsonObject } from "./columns";

// ── nodes ────────────────────────────────────────────────────────────────────

export const nodes = sqliteTable("nodes", {
	nodeId: text("node_id").primaryKey().$type<NodeId>(),
	runtimeType: text("runtime_type").notNull().$type<RuntimeType>(),
	capacity: jsonObject<NodeCapacity>("capacity").notNull(),
	status: text("status").notNull().default("online").$type<NodeStatus>(),
	statusDetail: text("status_detail"),
	lastHeartbeat: timestamp("last_heartbeat").notNull(),
	createdAt: timestamp("created_at").notNull(),
});

// ── workloads ────────────────────────────────────────────────────────────────

export const workloads = sqliteTable(
	"workloads",
	{
		workloadId: text("workload_id").primaryKey().$type<WorkloadId>(),
		name: text("name").notNull(),
		version: text("version").notNull(),
		config: jsonObject<Workload>("config").notNull(),
		status: text("status").notNull().default("ready").$type<WorkloadStatus>(),
		statusDetail: text("status_detail"),
		createdAt: timestamp("created_at").notNull(),
		updatedAt: timestamp("updated_at").notNull(),
	},
	(table) => [unique("workloads_name_version_uniq").on(table.name, table.version)],
);

// ── instances ────────────────────────────────────────────────────────────────

export const instances = sqliteTable(
	"instances",
	{
		instanceId: text("instance_id").primaryKey().$type<InstanceId>(),
		workloadId: text("workload_id")
			.notNull()
			.$type<WorkloadId>()
			.references(() => workloads.workloadId),
		nodeId: text("node_id")
			.notNull()
			.$type<NodeId>()
			.references(() => nodes.nodeId),
		tenantId: text("tenant_id").$type<TenantId>(),
		status: text("status")
			.notNull()
			.default("starting")
			.$type<InstanceStatus>(),
		statusDetail: text("status_detail"),
		runtimeMeta: jsonObject<Record<string, unknown>>("runtime_meta"),
		lastActivity: timestamp("last_activity"),
		claimedAt: timestamp("claimed_at"),
		poolStatus: text("pool_status").$type<PoolStatus>(),
		createdAt: timestamp("created_at").notNull(),
	},
	(table) => [
		index("instances_workload_id_idx").on(table.workloadId),
		index("instances_node_id_idx").on(table.nodeId),
		index("instances_tenant_id_idx").on(table.tenantId),
		index("instances_status_idx").on(table.status),
	],
);

// ── snapshots ────────────────────────────────────────────────────────────────

export const snapshots = sqliteTable(
	"snapshots",
	{
		snapshotId: text("snapshot_id").primaryKey().$type<SnapshotId>(),
		type: text("type").notNull().$type<SnapshotType>(),
		instanceId: text("instance_id").notNull().$type<InstanceId>(),
		tenantId: text("tenant_id").$type<TenantId>(),
		workloadId: text("workload_id")
			.notNull()
			.$type<WorkloadId>()
			.references(() => workloads.workloadId),
		nodeId: text("node_id")
			.notNull()
			.$type<NodeId>()
			.references(() => nodes.nodeId),
		status: text("status").notNull().default("ready").$type<SnapshotStatus>(),
		statusDetail: text("status_detail"),
		vmstatePath: text("vmstate_path").notNull(),
		memoryPath: text("memory_path"),
		archiveHmac: text("archive_hmac"),
		encrypted: integer("encrypted", { mode: "boolean" }).default(false),
		sizeBytes: integer("size_bytes").notNull(),
		runtimeMeta: jsonObject<Record<string, unknown>>("runtime_meta"),
		expiresAt: timestamp("expires_at"),
		createdAt: timestamp("created_at").notNull(),
	},
	(table) => [
		index("snapshots_workload_id_idx").on(table.workloadId),
		index("snapshots_node_id_idx").on(table.nodeId),
		index("snapshots_tenant_id_idx").on(table.tenantId),
		index("snapshots_type_idx").on(table.type),
		index("snapshots_status_idx").on(table.status),
	],
);

// ── tenants ──────────────────────────────────────────────────────────────────

export const tenants = sqliteTable(
	"tenants",
	{
		tenantId: text("tenant_id").notNull().$type<TenantId>(),
		workloadId: text("workload_id")
			.notNull()
			.$type<WorkloadId>()
			.references(() => workloads.workloadId),
		lastSnapshotId: text("last_snapshot_id").$type<SnapshotId>(),
		dataOverlayRef: text("data_overlay_ref"),
		lastActivity: timestamp("last_activity"),
		createdAt: timestamp("created_at").notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.tenantId, table.workloadId] }),
		index("tenants_workload_id_idx").on(table.workloadId),
	],
);

// ── claims ────────────────────────────────────────────────────────────────────

export const claims = sqliteTable(
	"claims",
	{
		claimId: text("claim_id").primaryKey().$type<ClaimId>(),
		tenantId: text("tenant_id")
			.notNull()
			.$type<TenantId>(),
		workloadId: text("workload_id")
			.notNull()
			.$type<WorkloadId>()
			.references(() => workloads.workloadId),
		instanceId: text("instance_id").$type<InstanceId>(),
		status: text("status").notNull().$type<ClaimStatus>(),
		createdAt: timestamp("created_at").notNull(),
	},
	(table) => [
		unique("claims_tenant_workload_uniq").on(table.tenantId, table.workloadId),
		index("claims_instance_id_idx").on(table.instanceId),
		index("claims_status_idx").on(table.status),
	],
);

export type ClaimRow = typeof claims.$inferSelect;
export type ClaimInsert = typeof claims.$inferInsert;

// ── activity_log ─────────────────────────────────────────────────────────────

export const activityLog = sqliteTable(
	"activity_log",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		instanceId: text("instance_id").$type<InstanceId>(),
		workloadId: text("workload_id").$type<WorkloadId>(),
		nodeId: text("node_id").$type<NodeId>(),
		tenantId: text("tenant_id").$type<TenantId>(),
		event: text("event").notNull(),
		metadata: jsonObject<Record<string, unknown>>("metadata"),
		createdAt: timestamp("created_at").notNull(),
	},
	(table) => [
		index("activity_log_instance_id_idx").on(table.instanceId),
		index("activity_log_tenant_id_idx").on(table.tenantId),
		index("activity_log_event_idx").on(table.event),
		index("activity_log_created_at_idx").on(table.createdAt),
	],
);

// ── tenant_secrets ──────────────────────────────────────────────────────────

export const tenantSecrets = sqliteTable(
	"tenant_secrets",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		tenantId: text("tenant_id").notNull().$type<TenantId>(),
		name: text("name").notNull(),
		encryptedValue: text("encrypted_value").notNull(),
		iv: text("iv").notNull(),
		authTag: text("auth_tag").notNull(),
		createdAt: timestamp("created_at").notNull(),
		updatedAt: timestamp("updated_at").notNull(),
	},
	(table) => [
		unique("tenant_secrets_tenant_name_uniq").on(table.tenantId, table.name),
		index("tenant_secrets_tenant_id_idx").on(table.tenantId),
	],
);

// ── build_logs ──────────────────────────────────────────────────────────────

export const buildLogs = sqliteTable(
	"build_logs",
	{
		id: integer("id").primaryKey({ autoIncrement: true }),
		workloadId: text("workload_id")
			.notNull()
			.$type<WorkloadId>(),
		text: text("text").notNull(),
		createdAt: timestamp("created_at").notNull(),
	},
	(table) => [
		index("build_logs_workload_id_idx").on(table.workloadId),
	],
);

// ── triggers ────────────────────────────────────────────────────────────────

/** Adapter-specific configuration stored as JSON. */
type TriggerAdapterConfig = Record<string, unknown>;

/** @example "webhook" | "slack" | "telegram" | "telegram-poll" | "cron" */
type TriggerType = "webhook" | "slack" | "telegram" | "telegram-poll" | "cron";

/** How to resolve tenant ID for a trigger event. */
type TenantMapping =
	| { static: string }
	| { fromField: string; prefix?: string };

export const triggers = sqliteTable("triggers", {
	id: text("id").primaryKey().$type<TriggerId>(),
	name: text("name").notNull().unique(),
	type: text("type").notNull().$type<TriggerType>(),
	tenant: jsonObject<TenantMapping>("tenant").notNull(),
	workload: text("workload").notNull(),
	config: jsonObject<TriggerAdapterConfig>("config").notNull(),
	/** Driver package name for WebSocket protocol translation. */
	driver: text("driver"),
	/** Driver-specific options (e.g. `{ gatewayToken: "..." }`). */
	driverOptions: jsonObject<Record<string, unknown>>("driver_options"),
	/** Guard package name or path for access control. */
	guard: text("guard"),
	/** Guard-specific options passed to guard.check() as ctx.options. */
	guardOptions: jsonObject<Record<string, unknown>>("guard_options"),
	enabled: integer("enabled").notNull().default(1),
	lastInvokedAt: timestamp("last_invoked_at"),
	createdAt: timestamp("created_at").notNull(),
	updatedAt: timestamp("updated_at").notNull(),
});

// ── Row types (inferred from schema) ─────────────────────────────────────────

export type NodeRow = typeof nodes.$inferSelect;
export type NodeInsert = typeof nodes.$inferInsert;

export type WorkloadRow = typeof workloads.$inferSelect;
export type WorkloadInsert = typeof workloads.$inferInsert;

export type InstanceRow = typeof instances.$inferSelect;
export type InstanceInsert = typeof instances.$inferInsert;

export type SnapshotRow = typeof snapshots.$inferSelect;
export type SnapshotInsert = typeof snapshots.$inferInsert;

export type TenantRow = typeof tenants.$inferSelect;
export type TenantInsert = typeof tenants.$inferInsert;

export type ActivityLogRow = typeof activityLog.$inferSelect;
export type ActivityLogInsert = typeof activityLog.$inferInsert;

export type BuildLogRow = typeof buildLogs.$inferSelect;
export type BuildLogInsert = typeof buildLogs.$inferInsert;

export type TenantSecretRow = typeof tenantSecrets.$inferSelect;
export type TenantSecretInsert = typeof tenantSecrets.$inferInsert;

export type TriggerRow = typeof triggers.$inferSelect;
export type TriggerInsert = typeof triggers.$inferInsert;

// ── Schema bundle (for drizzle() calls) ──────────────────────────────────────

export const schema = {
	nodes,
	workloads,
	instances,
	snapshots,
	tenants,
	claims,
	activityLog,
	buildLogs,
	tenantSecrets,
	triggers,
};
