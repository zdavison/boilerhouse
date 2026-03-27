import { describe, test, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { createTestDatabase, type DrizzleDb } from "./database";
import {
	nodes,
	workloads,
	instances,
	snapshots,
	tenants,
	activityLog,
} from "./schema";
import type {
	NodeId,
	NodeCapacity,
	WorkloadId,
	Workload,
	InstanceId,
	TenantId,
	SnapshotId,
	SnapshotType,
	InstanceStatus,
} from "@boilerhouse/core";

// ── Helpers ──────────────────────────────────────────────────────────────────

let db: DrizzleDb;

beforeEach(() => {
	db = createTestDatabase();
});

const now = new Date("2025-06-15T12:00:00.000Z");

const sampleCapacity: NodeCapacity = { vcpus: 4, memoryMb: 1024, diskGb: 10 };

const sampleWorkloadConfig = {
	workload: { name: "web-app", version: "1.0.0" },
	image: { ref: "ghcr.io/example/web:latest" },
	resources: { vcpus: 2, memory_mb: 512, disk_gb: 2 },
	network: { access: "none" as const },
	idle: { action: "hibernate" as const },
} as Workload;

function insertNode(id = "node-1" as NodeId) {
	db.insert(nodes)
		.values({
			nodeId: id,
			runtimeType: "podman",
			capacity: sampleCapacity,
			lastHeartbeat: now,
			createdAt: now,
		})
		.run();
	return id;
}

function insertWorkload(id = "wl-1" as WorkloadId, name = "web-app", version = "1.0.0") {
	db.insert(workloads)
		.values({
			workloadId: id,
			name,
			version,
			config: sampleWorkloadConfig,
			createdAt: now,
			updatedAt: now,
		})
		.run();
	return id;
}

function insertInstance(
	id = "inst-1" as InstanceId,
	workloadId = "wl-1" as WorkloadId,
	nodeId = "node-1" as NodeId,
) {
	db.insert(instances)
		.values({
			instanceId: id,
			workloadId,
			nodeId,
			createdAt: now,
		})
		.run();
	return id;
}

// ── nodes ────────────────────────────────────────────────────────────────────

describe("nodes table", () => {
	test("insert and select", () => {
		insertNode();
		const rows = db.select().from(nodes).all();
		expect(rows).toHaveLength(1);
		expect(rows[0]!.nodeId).toBe("node-1" as NodeId);
		expect(rows[0]!.runtimeType).toBe("podman");
		expect(rows[0]!.status).toBe("online");
	});

	test("jsonObject round-trips capacity", () => {
		insertNode();
		const row = db.select().from(nodes).get();
		expect(row!.capacity).toEqual(sampleCapacity);
	});

	test("timestamp round-trips dates", () => {
		insertNode();
		const row = db.select().from(nodes).get();
		expect(row!.createdAt).toBeInstanceOf(Date);
		expect(row!.createdAt.getTime()).toBe(now.getTime());
		expect(row!.lastHeartbeat.getTime()).toBe(now.getTime());
	});

	test("update status", () => {
		insertNode();
		db.update(nodes)
			.set({ status: "draining" })
			.where(eq(nodes.nodeId, "node-1" as NodeId))
			.run();

		const row = db.select().from(nodes).get();
		expect(row!.status).toBe("draining");
	});

	test("delete", () => {
		insertNode();
		db.delete(nodes).where(eq(nodes.nodeId, "node-1" as NodeId)).run();
		expect(db.select().from(nodes).all()).toHaveLength(0);
	});

	test("primary key uniqueness", () => {
		insertNode();
		expect(() => insertNode()).toThrow();
	});
});

// ── workloads ────────────────────────────────────────────────────────────────

describe("workloads table", () => {
	test("insert and select", () => {
		insertWorkload();
		const rows = db.select().from(workloads).all();
		expect(rows).toHaveLength(1);
		expect(rows[0]!.name).toBe("web-app");
		expect(rows[0]!.version).toBe("1.0.0");
	});

	test("jsonObject round-trips workload config", () => {
		insertWorkload();
		const row = db.select().from(workloads).get();
		expect(row!.config).toEqual(sampleWorkloadConfig);
	});

	test("unique constraint on (name, version)", () => {
		insertWorkload("wl-1" as WorkloadId, "my-app", "1.0.0");
		expect(() => insertWorkload("wl-2" as WorkloadId, "my-app", "1.0.0")).toThrow();
	});

	test("same name different version allowed", () => {
		insertWorkload("wl-1" as WorkloadId, "my-app", "1.0.0");
		insertWorkload("wl-2" as WorkloadId, "my-app", "2.0.0");
		expect(db.select().from(workloads).all()).toHaveLength(2);
	});

	test("update", () => {
		insertWorkload();
		const later = new Date("2025-07-01T00:00:00.000Z");
		db.update(workloads)
			.set({ updatedAt: later })
			.where(eq(workloads.workloadId, "wl-1" as WorkloadId))
			.run();

		const row = db.select().from(workloads).get();
		expect(row!.updatedAt.getTime()).toBe(later.getTime());
	});

	test("delete", () => {
		insertWorkload();
		db.delete(workloads)
			.where(eq(workloads.workloadId, "wl-1" as WorkloadId))
			.run();
		expect(db.select().from(workloads).all()).toHaveLength(0);
	});
});

// ── instances ────────────────────────────────────────────────────────────────

describe("instances table", () => {
	test("insert and select with FK parents", () => {
		insertNode();
		insertWorkload();
		insertInstance();

		const rows = db.select().from(instances).all();
		expect(rows).toHaveLength(1);
		expect(rows[0]!.status).toBe("starting" as InstanceStatus);
		expect(rows[0]!.tenantId).toBeNull();
		expect(rows[0]!.runtimeMeta).toBeNull();
		expect(rows[0]!.lastActivity).toBeNull();
		expect(rows[0]!.claimedAt).toBeNull();
	});

	test("FK constraint — missing workload", () => {
		insertNode();
		expect(() => insertInstance()).toThrow();
	});

	test("FK constraint — missing node", () => {
		insertWorkload();
		expect(() => insertInstance()).toThrow();
	});

	test("update status and tenantId", () => {
		insertNode();
		insertWorkload();
		insertInstance();

		db.update(instances)
			.set({
				status: "active" as InstanceStatus,
				tenantId: "tenant-1" as TenantId,
				claimedAt: now,
			})
			.where(eq(instances.instanceId, "inst-1" as InstanceId))
			.run();

		const row = db.select().from(instances).get();
		expect(row!.status).toBe("active" as InstanceStatus);
		expect(row!.tenantId).toBe("tenant-1" as TenantId);
		expect(row!.claimedAt!.getTime()).toBe(now.getTime());
	});

	test("runtimeMeta jsonObject round-trip", () => {
		insertNode();
		insertWorkload();

		db.insert(instances)
			.values({
				instanceId: "inst-meta" as InstanceId,
				workloadId: "wl-1" as WorkloadId,
				nodeId: "node-1" as NodeId,
				runtimeMeta: { socketPath: "/tmp/fc.sock", pid: 1234 },
				createdAt: now,
			})
			.run();

		const row = db
			.select()
			.from(instances)
			.where(eq(instances.instanceId, "inst-meta" as InstanceId))
			.get();
		expect(row!.runtimeMeta).toEqual({ socketPath: "/tmp/fc.sock", pid: 1234 });
	});

	test("delete", () => {
		insertNode();
		insertWorkload();
		insertInstance();
		db.delete(instances)
			.where(eq(instances.instanceId, "inst-1" as InstanceId))
			.run();
		expect(db.select().from(instances).all()).toHaveLength(0);
	});

	test("FK RESTRICT — cannot delete node with instance", () => {
		insertNode();
		insertWorkload();
		insertInstance();
		expect(() =>
			db.delete(nodes).where(eq(nodes.nodeId, "node-1" as NodeId)).run(),
		).toThrow();
	});

	test("FK RESTRICT — cannot delete workload with instance", () => {
		insertNode();
		insertWorkload();
		insertInstance();
		expect(() =>
			db
				.delete(workloads)
				.where(eq(workloads.workloadId, "wl-1" as WorkloadId))
				.run(),
		).toThrow();
	});
});

// ── snapshots ────────────────────────────────────────────────────────────────

describe("snapshots table", () => {
	test("insert golden snapshot (no tenantId, no memoryPath)", () => {
		insertNode();
		insertWorkload();

		db.insert(snapshots)
			.values({
				snapshotId: "snap-1" as SnapshotId,
				type: "golden" as SnapshotType,
				instanceId: "inst-ghost" as InstanceId,
				workloadId: "wl-1" as WorkloadId,
				nodeId: "node-1" as NodeId,
				vmstatePath: "/snapshots/vmstate.bin",
				sizeBytes: 1024 * 1024,
				createdAt: now,
			})
			.run();

		const row = db.select().from(snapshots).get();
		expect(row!.type).toBe("golden" as SnapshotType);
		expect(row!.tenantId).toBeNull();
		expect(row!.memoryPath).toBeNull();
		expect(row!.runtimeMeta).toBeNull();
		expect(row!.expiresAt).toBeNull();
	});

	test("insert tenant snapshot with all fields", () => {
		insertNode();
		insertWorkload();
		const expires = new Date("2025-12-31T23:59:59.000Z");

		db.insert(snapshots)
			.values({
				snapshotId: "snap-2" as SnapshotId,
				type: "tenant" as SnapshotType,
				instanceId: "inst-ghost" as InstanceId,
				tenantId: "tenant-1" as TenantId,
				workloadId: "wl-1" as WorkloadId,
				nodeId: "node-1" as NodeId,
				vmstatePath: "/snapshots/vm.bin",
				memoryPath: "/snapshots/mem.bin",
				sizeBytes: 2048,
				runtimeMeta: { fcVersion: "1.5.0" },
				expiresAt: expires,
				createdAt: now,
			})
			.run();

		const row = db.select().from(snapshots).get();
		expect(row!.tenantId).toBe("tenant-1" as TenantId);
		expect(row!.memoryPath).toBe("/snapshots/mem.bin");
		expect(row!.runtimeMeta).toEqual({ fcVersion: "1.5.0" });
		expect(row!.expiresAt!.getTime()).toBe(expires.getTime());
	});

	test("instanceId is NOT a FK — can insert with nonexistent instance", () => {
		insertNode();
		insertWorkload();

		db.insert(snapshots)
			.values({
				snapshotId: "snap-3" as SnapshotId,
				type: "golden" as SnapshotType,
				instanceId: "inst-nonexistent" as InstanceId,
				workloadId: "wl-1" as WorkloadId,
				nodeId: "node-1" as NodeId,
				vmstatePath: "/snapshots/vm.bin",
				sizeBytes: 512,
				createdAt: now,
			})
			.run();

		expect(db.select().from(snapshots).all()).toHaveLength(1);
	});

	test("FK constraint — workload must exist", () => {
		insertNode();

		expect(() =>
			db
				.insert(snapshots)
				.values({
					snapshotId: "snap-fk" as SnapshotId,
					type: "golden" as SnapshotType,
					instanceId: "inst-x" as InstanceId,
					workloadId: "wl-missing" as WorkloadId,
					nodeId: "node-1" as NodeId,
					vmstatePath: "/snap/vm.bin",
					sizeBytes: 100,
					createdAt: now,
				})
				.run(),
		).toThrow();
	});

	test("delete", () => {
		insertNode();
		insertWorkload();

		db.insert(snapshots)
			.values({
				snapshotId: "snap-del" as SnapshotId,
				type: "golden" as SnapshotType,
				instanceId: "inst-x" as InstanceId,
				workloadId: "wl-1" as WorkloadId,
				nodeId: "node-1" as NodeId,
				vmstatePath: "/snap/vm.bin",
				sizeBytes: 100,
				createdAt: now,
			})
			.run();

		db.delete(snapshots)
			.where(eq(snapshots.snapshotId, "snap-del" as SnapshotId))
			.run();
		expect(db.select().from(snapshots).all()).toHaveLength(0);
	});
});

// ── tenants ──────────────────────────────────────────────────────────────────

describe("tenants table", () => {
	test("insert and select", () => {
		insertWorkload();

		db.insert(tenants)
			.values({
				tenantId: "tenant-1" as TenantId,
				workloadId: "wl-1" as WorkloadId,
				createdAt: now,
			})
			.run();

		const row = db.select().from(tenants).get();
		expect(row!.tenantId).toBe("tenant-1" as TenantId);
		expect(row!.lastSnapshotId).toBeNull();
		expect(row!.dataOverlayRef).toBeNull();
		expect(row!.lastActivity).toBeNull();
	});

	test("lastSnapshotId is NOT a FK — can reference nonexistent snapshot", () => {
		insertWorkload();

		db.insert(tenants)
			.values({
				tenantId: "tenant-3" as TenantId,
				workloadId: "wl-1" as WorkloadId,
				lastSnapshotId: "snap-gone" as SnapshotId,
				createdAt: now,
			})
			.run();

		expect(db.select().from(tenants).all()).toHaveLength(1);
	});

	test("FK constraint — workload must exist", () => {
		expect(() =>
			db
				.insert(tenants)
				.values({
					tenantId: "tenant-fk" as TenantId,
					workloadId: "wl-missing" as WorkloadId,
					createdAt: now,
				})
				.run(),
		).toThrow();
	});

	test("update with activity and overlayRef", () => {
		insertWorkload();
		db.insert(tenants)
			.values({
				tenantId: "tenant-upd" as TenantId,
				workloadId: "wl-1" as WorkloadId,
				createdAt: now,
			})
			.run();

		const activity = new Date("2025-06-15T14:00:00.000Z");
		db.update(tenants)
			.set({
				lastActivity: activity,
				dataOverlayRef: "/overlays/tenant-upd",
			})
			.where(eq(tenants.tenantId, "tenant-upd" as TenantId))
			.run();

		const row = db.select().from(tenants).get();
		expect(row!.lastActivity!.getTime()).toBe(activity.getTime());
		expect(row!.dataOverlayRef).toBe("/overlays/tenant-upd");
	});

	test("delete", () => {
		insertWorkload();
		db.insert(tenants)
			.values({
				tenantId: "tenant-del" as TenantId,
				workloadId: "wl-1" as WorkloadId,
				createdAt: now,
			})
			.run();

		db.delete(tenants)
			.where(eq(tenants.tenantId, "tenant-del" as TenantId))
			.run();
		expect(db.select().from(tenants).all()).toHaveLength(0);
	});
});

// ── activity_log ─────────────────────────────────────────────────────────────

describe("activityLog table", () => {
	test("insert with auto-increment id", () => {
		db.insert(activityLog)
			.values({
				event: "instance.started",
				instanceId: "inst-1" as InstanceId,
				createdAt: now,
			})
			.run();

		db.insert(activityLog)
			.values({
				event: "instance.destroyed",
				instanceId: "inst-1" as InstanceId,
				createdAt: now,
			})
			.run();

		const rows = db.select().from(activityLog).all();
		expect(rows).toHaveLength(2);
		expect(rows[0]!.id).toBe(1);
		expect(rows[1]!.id).toBe(2);
	});

	test("all entity IDs are nullable", () => {
		db.insert(activityLog)
			.values({
				event: "system.startup",
				createdAt: now,
			})
			.run();

		const row = db.select().from(activityLog).get();
		expect(row!.instanceId).toBeNull();
		expect(row!.workloadId).toBeNull();
		expect(row!.nodeId).toBeNull();
		expect(row!.tenantId).toBeNull();
	});

	test("metadata jsonObject round-trip", () => {
		db.insert(activityLog)
			.values({
				event: "instance.error",
				metadata: { error: "OOM", exitCode: 137 },
				createdAt: now,
			})
			.run();

		const row = db.select().from(activityLog).get();
		expect(row!.metadata).toEqual({ error: "OOM", exitCode: 137 });
	});

	test("nullable metadata", () => {
		db.insert(activityLog)
			.values({ event: "test", createdAt: now })
			.run();

		const row = db.select().from(activityLog).get();
		expect(row!.metadata).toBeNull();
	});

	test("delete", () => {
		db.insert(activityLog)
			.values({ event: "test", createdAt: now })
			.run();

		db.delete(activityLog).where(eq(activityLog.id, 1)).run();
		expect(db.select().from(activityLog).all()).toHaveLength(0);
	});
});
