import { describe, test, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import {
	type WorkloadId,
	type NodeId,
	type Workload,
	FakeRuntime,
	InvalidTransitionError,
	generateWorkloadId,
	generateNodeId,
} from "@boilerhouse/core";
import {
	createTestDatabase,
	type DrizzleDb,
	ActivityLog,
	instances,
	nodes,
	workloads,
} from "@boilerhouse/db";
import { InstanceManager } from "./instance-manager";
import { createTestAudit } from "./test-helpers";

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
			runtimeType: "podman",
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

	manager = new InstanceManager(runtime, db, createTestAudit(db, nodeId), nodeId);
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

		test("logs 'instance.starting' and 'instance.created' activity", async () => {
			const handle = await manager.create(workloadId, TEST_WORKLOAD);

			const events = log.queryByInstance(handle.instanceId);
			expect(events).toHaveLength(2);
			expect(events[0]!.event).toBe("instance.starting");
			expect(events[1]!.event).toBe("instance.created");
			expect(events[1]!.workloadId).toBe(workloadId);
			expect(events[1]!.nodeId).toBe(nodeId);
		});

		test("rolls back the DB row on runtime failure", async () => {
			const failRuntime = new FakeRuntime({
				failOn: new Set(["create"]),
			});
			const failManager = new InstanceManager(
				failRuntime,
				db,
				createTestAudit(db, nodeId),
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

		test("throws InvalidTransitionError on already-destroyed instance", async () => {
			const handle = await manager.create(workloadId, TEST_WORKLOAD);
			await manager.destroy(handle.instanceId);

			await expect(
				manager.destroy(handle.instanceId),
			).rejects.toBeInstanceOf(InvalidTransitionError);
		});
	});

});
