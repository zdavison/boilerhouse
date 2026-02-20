import { describe, test, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import {
	type WorkloadId,
	type NodeId,
	type Workload,
	type SnapshotRef,
	FakeRuntime,
	generateWorkloadId,
	generateNodeId,
	generateTenantId,
	generateSnapshotId,
} from "@boilerhouse/core";
import {
	createTestDatabase,
	type DrizzleDb,
	ActivityLog,
	instances,
	snapshots,
	tenants,
	nodes,
	workloads,
} from "@boilerhouse/db";
import { InstanceManager, SnapshotNotFoundError } from "./instance-manager";

const TEST_WORKLOAD: Workload = {
	workload: { name: "test", version: "1.0.0" },
	image: { ref: "test:latest" },
	resources: { vcpus: 1, memory_mb: 256, disk_gb: 2 },
	network: { access: "none" },
	idle: { action: "hibernate" },
};

let db: DrizzleDb;
let runtime: FakeRuntime;
let log: ActivityLog;
let manager: InstanceManager;
let nodeId: NodeId;
let workloadId: WorkloadId;

beforeEach(() => {
	db = createTestDatabase();
	runtime = new FakeRuntime();
	log = new ActivityLog(db);
	nodeId = generateNodeId();
	workloadId = generateWorkloadId();

	// Seed node and workload rows for FK constraints
	db.insert(nodes)
		.values({
			nodeId,
			runtimeType: "firecracker",
			capacity: { vcpus: 8, memoryMb: 16384, diskGb: 100 },
			status: "online",
			lastHeartbeat: new Date(),
			createdAt: new Date(),
		})
		.run();

	db.insert(workloads)
		.values({
			workloadId,
			name: "test",
			version: "1.0.0",
			config: TEST_WORKLOAD,
			createdAt: new Date(),
			updatedAt: new Date(),
		})
		.run();

	manager = new InstanceManager(runtime, db, log, nodeId);
});

// ── 3.1 — create & destroy ──────────────────────────────────────────────────

describe("InstanceManager", () => {
	describe("create()", () => {
		test("calls runtime.create() and runtime.start()", async () => {
			const handle = await manager.create(workloadId, TEST_WORKLOAD);

			expect(handle.running).toBe(true);
			expect(handle.instanceId).toBeTruthy();
		});

		test("inserts an instance row with status 'active'", async () => {
			const handle = await manager.create(workloadId, TEST_WORKLOAD);

			const row = db
				.select()
				.from(instances)
				.where(eq(instances.instanceId, handle.instanceId))
				.get();

			expect(row).toBeDefined();
			expect(row!.status).toBe("active");
		});

		test("records the nodeId on the instance row", async () => {
			const handle = await manager.create(workloadId, TEST_WORKLOAD);

			const row = db
				.select()
				.from(instances)
				.where(eq(instances.instanceId, handle.instanceId))
				.get();

			expect(row!.nodeId).toBe(nodeId);
		});

		test("logs 'instance.created' activity", async () => {
			const handle = await manager.create(workloadId, TEST_WORKLOAD);

			const events = log.queryByInstance(handle.instanceId);
			expect(events).toHaveLength(1);
			expect(events[0]!.event).toBe("instance.created");
			expect(events[0]!.workloadId).toBe(workloadId);
			expect(events[0]!.nodeId).toBe(nodeId);
		});

		test("rolls back the DB row on runtime failure", async () => {
			const failRuntime = new FakeRuntime({
				failOn: new Set(["create"]),
			});
			const failManager = new InstanceManager(
				failRuntime,
				db,
				log,
				nodeId,
			);

			await expect(
				failManager.create(workloadId, TEST_WORKLOAD),
			).rejects.toThrow("Injected failure");

			const rows = db.select().from(instances).all();
			expect(rows).toHaveLength(0);
		});
	});

	describe("destroy()", () => {
		test("calls runtime.destroy()", async () => {
			const handle = await manager.create(workloadId, TEST_WORKLOAD);
			await manager.destroy(handle.instanceId);

			// Runtime should no longer know about this instance
			await expect(
				runtime.getEndpoint(handle),
			).rejects.toThrow("not found");
		});

		test("updates instance status to 'destroyed'", async () => {
			const handle = await manager.create(workloadId, TEST_WORKLOAD);
			await manager.destroy(handle.instanceId);

			const row = db
				.select()
				.from(instances)
				.where(eq(instances.instanceId, handle.instanceId))
				.get();

			expect(row!.status).toBe("destroyed");
		});

		test("logs 'instance.destroyed' activity", async () => {
			const handle = await manager.create(workloadId, TEST_WORKLOAD);
			await manager.destroy(handle.instanceId);

			const events = log.queryByInstance(handle.instanceId);
			const destroyEvent = events.find(
				(e) => e.event === "instance.destroyed",
			);
			expect(destroyEvent).toBeDefined();
			expect(destroyEvent!.nodeId).toBe(nodeId);
			expect(destroyEvent!.workloadId).toBe(workloadId);
		});

		test("is idempotent on already-destroyed instance", async () => {
			const handle = await manager.create(workloadId, TEST_WORKLOAD);
			await manager.destroy(handle.instanceId);

			// Second destroy should not throw
			await expect(
				manager.destroy(handle.instanceId),
			).resolves.toBeUndefined();
		});
	});

	// ── 3.2 — stop & hibernate ──────────────────────────────────────────────

	describe("stop()", () => {
		test("calls runtime.stop() and updates status to 'destroyed'", async () => {
			const handle = await manager.create(workloadId, TEST_WORKLOAD);
			await manager.stop(handle.instanceId);

			const row = db
				.select()
				.from(instances)
				.where(eq(instances.instanceId, handle.instanceId))
				.get();

			expect(row!.status).toBe("destroyed");
		});

		test("logs 'instance.stopped' activity", async () => {
			const handle = await manager.create(workloadId, TEST_WORKLOAD);
			await manager.stop(handle.instanceId);

			const events = log.queryByInstance(handle.instanceId);
			const stopEvent = events.find(
				(e) => e.event === "instance.stopped",
			);
			expect(stopEvent).toBeDefined();
			expect(stopEvent!.nodeId).toBe(nodeId);
		});
	});

	describe("hibernate()", () => {
		test("calls runtime.snapshot() then runtime.destroy()", async () => {
			const handle = await manager.create(workloadId, TEST_WORKLOAD);
			await manager.hibernate(handle.instanceId);

			// Runtime should no longer know about the instance (destroyed)
			await expect(
				runtime.getEndpoint(handle),
			).rejects.toThrow("not found");
		});

		test("inserts a snapshot row with type 'tenant'", async () => {
			const handle = await manager.create(workloadId, TEST_WORKLOAD);
			const ref = await manager.hibernate(handle.instanceId);

			const row = db
				.select()
				.from(snapshots)
				.where(eq(snapshots.snapshotId, ref.id))
				.get();

			expect(row).toBeDefined();
			expect(row!.type).toBe("tenant");
			expect(row!.instanceId).toBe(handle.instanceId);
			expect(row!.workloadId).toBe(workloadId);
			expect(row!.nodeId).toBe(nodeId);
		});

		test("updates instance status to 'hibernated'", async () => {
			const handle = await manager.create(workloadId, TEST_WORKLOAD);
			await manager.hibernate(handle.instanceId);

			const row = db
				.select()
				.from(instances)
				.where(eq(instances.instanceId, handle.instanceId))
				.get();

			expect(row!.status).toBe("hibernated");
		});

		test("logs 'instance.hibernated' activity", async () => {
			const handle = await manager.create(workloadId, TEST_WORKLOAD);
			const ref = await manager.hibernate(handle.instanceId);

			const events = log.queryByInstance(handle.instanceId);
			const hibEvent = events.find(
				(e) => e.event === "instance.hibernated",
			);
			expect(hibEvent).toBeDefined();
			expect(hibEvent!.metadata).toEqual(
				expect.objectContaining({ snapshotId: ref.id }),
			);
		});

		test("saves snapshotId on the tenant row", async () => {
			const tenantId = generateTenantId();

			// Insert tenant row
			db.insert(tenants)
				.values({
					tenantId,
					workloadId,
					createdAt: new Date(),
				})
				.run();

			// Create instance assigned to the tenant
			const handle = await manager.create(workloadId, TEST_WORKLOAD);
			db.update(instances)
				.set({ tenantId })
				.where(eq(instances.instanceId, handle.instanceId))
				.run();

			const ref = await manager.hibernate(handle.instanceId);

			const tenantRow = db
				.select()
				.from(tenants)
				.where(eq(tenants.tenantId, tenantId))
				.get();

			expect(tenantRow!.lastSnapshotId).toBe(ref.id);
		});

		test("falls back to destroy on snapshot failure", async () => {
			const failRuntime = new FakeRuntime({
				failOn: new Set(["snapshot"]),
			});
			const failManager = new InstanceManager(
				failRuntime,
				db,
				log,
				nodeId,
			);

			const handle = await failManager.create(workloadId, TEST_WORKLOAD);

			await expect(
				failManager.hibernate(handle.instanceId),
			).rejects.toThrow("Injected failure");

			const row = db
				.select()
				.from(instances)
				.where(eq(instances.instanceId, handle.instanceId))
				.get();

			expect(row!.status).toBe("destroyed");
		});
	});

	// ── 3.3 — restore ───────────────────────────────────────────────────────

	describe("restoreFromSnapshot()", () => {
		test("calls runtime.restore() with the SnapshotRef", async () => {
			const handle = await manager.create(workloadId, TEST_WORKLOAD);
			const ref = await manager.hibernate(handle.instanceId);
			const tenantId = generateTenantId();

			db.insert(tenants)
				.values({ tenantId, workloadId, createdAt: new Date() })
				.run();

			const restored = await manager.restoreFromSnapshot(ref, tenantId);
			expect(restored.running).toBe(true);
			expect(restored.instanceId).toBeTruthy();
			// Should be a new instance, not the old one
			expect(restored.instanceId).not.toBe(handle.instanceId);
		});

		test("inserts instance row with status 'active'", async () => {
			const handle = await manager.create(workloadId, TEST_WORKLOAD);
			const ref = await manager.hibernate(handle.instanceId);
			const tenantId = generateTenantId();

			db.insert(tenants)
				.values({ tenantId, workloadId, createdAt: new Date() })
				.run();

			const restored = await manager.restoreFromSnapshot(ref, tenantId);

			const row = db
				.select()
				.from(instances)
				.where(eq(instances.instanceId, restored.instanceId))
				.get();

			expect(row).toBeDefined();
			expect(row!.status).toBe("active");
		});

		test("assigns the tenantId to the instance", async () => {
			const handle = await manager.create(workloadId, TEST_WORKLOAD);
			const ref = await manager.hibernate(handle.instanceId);
			const tenantId = generateTenantId();

			db.insert(tenants)
				.values({ tenantId, workloadId, createdAt: new Date() })
				.run();

			const restored = await manager.restoreFromSnapshot(ref, tenantId);

			const row = db
				.select()
				.from(instances)
				.where(eq(instances.instanceId, restored.instanceId))
				.get();

			expect(row!.tenantId).toBe(tenantId);
		});

		test("logs 'instance.restored' activity with snapshot metadata", async () => {
			const handle = await manager.create(workloadId, TEST_WORKLOAD);
			const ref = await manager.hibernate(handle.instanceId);
			const tenantId = generateTenantId();

			db.insert(tenants)
				.values({ tenantId, workloadId, createdAt: new Date() })
				.run();

			const restored = await manager.restoreFromSnapshot(ref, tenantId);

			const events = log.queryByInstance(restored.instanceId);
			const restoreEvent = events.find(
				(e) => e.event === "instance.restored",
			);
			expect(restoreEvent).toBeDefined();
			expect(restoreEvent!.tenantId).toBe(tenantId);
			expect(restoreEvent!.metadata).toEqual(
				expect.objectContaining({
					snapshotType: ref.type,
					snapshotId: ref.id,
				}),
			);
		});

		test("throws SnapshotNotFoundError for missing snapshot", async () => {
			const tenantId = generateTenantId();
			const fakeRef: SnapshotRef = {
				id: generateSnapshotId(),
				type: "tenant",
				paths: { memory: "/fake/mem", vmstate: "/fake/vm" },
				workloadId,
				nodeId,
				runtimeMeta: {
					runtimeVersion: "fake-1.0.0",
					cpuTemplate: "none",
					architecture: "x86_64",
				},
			};

			await expect(
				manager.restoreFromSnapshot(fakeRef, tenantId),
			).rejects.toBeInstanceOf(SnapshotNotFoundError);
		});
	});
});
