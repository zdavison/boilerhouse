import {
	sqliteTable,
	text,
	integer,
	index,
	unique,
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
	SnapshotId,
	SnapshotType,
	TenantStatus,
	SnapshotStatus,
} from "@boilerhouse/core";
import { timestamp, jsonObject } from "./columns";

// ── nodes ────────────────────────────────────────────────────────────────────

export const nodes = sqliteTable("nodes", {
	nodeId: text("node_id").primaryKey().$type<NodeId>(),
	runtimeType: text("runtime_type").notNull().$type<RuntimeType>(),
	capacity: jsonObject<NodeCapacity>("capacity").notNull(),
	status: text("status").notNull().default("online").$type<NodeStatus>(),
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
		runtimeMeta: jsonObject<Record<string, unknown>>("runtime_meta"),
		lastActivity: timestamp("last_activity"),
		claimedAt: timestamp("claimed_at"),
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
		vmstatePath: text("vmstate_path").notNull(),
		memoryPath: text("memory_path"),
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
		tenantId: text("tenant_id").primaryKey().$type<TenantId>(),
		workloadId: text("workload_id")
			.notNull()
			.$type<WorkloadId>()
			.references(() => workloads.workloadId),
		status: text("status").notNull().default("idle").$type<TenantStatus>(),
		instanceId: text("instance_id").$type<InstanceId>(),
		lastSnapshotId: text("last_snapshot_id").$type<SnapshotId>(),
		dataOverlayRef: text("data_overlay_ref"),
		lastActivity: timestamp("last_activity"),
		createdAt: timestamp("created_at").notNull(),
	},
	(table) => [
		index("tenants_workload_id_idx").on(table.workloadId),
		index("tenants_instance_id_idx").on(table.instanceId),
		index("tenants_status_idx").on(table.status),
	],
);

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

// ── Schema bundle (for drizzle() calls) ──────────────────────────────────────

export const schema = {
	nodes,
	workloads,
	instances,
	snapshots,
	tenants,
	activityLog,
};
