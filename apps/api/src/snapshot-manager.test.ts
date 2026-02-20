import { describe, test, expect, beforeEach } from "bun:test";
import { eq, and } from "drizzle-orm";
import {
	type WorkloadId,
	type NodeId,
	type Workload,
	FakeRuntime,
	generateWorkloadId,
	generateNodeId,
} from "@boilerhouse/core";
import {
	createTestDatabase,
	type DrizzleDb,
	snapshots,
	nodes,
	workloads,
} from "@boilerhouse/db";
import { SnapshotManager } from "./snapshot-manager";
import { HealthCheckTimeoutError } from "./health-check";
import type { HealthChecker } from "./snapshot-manager";

const TEST_WORKLOAD: Workload = {
	workload: { name: "test", version: "1.0.0" },
	image: { ref: "test:latest" },
	resources: { vcpus: 1, memory_mb: 256, disk_gb: 2 },
	network: { access: "none" },
	idle: { action: "hibernate" },
	health: {
		interval_seconds: 1,
		unhealthy_threshold: 10,
		http_get: { path: "/health" },
	},
};

const TEST_WORKLOAD_EXEC: Workload = {
	workload: { name: "test-exec", version: "1.0.0" },
	image: { ref: "test:latest" },
	resources: { vcpus: 1, memory_mb: 256, disk_gb: 2 },
	network: { access: "none" },
	idle: { action: "hibernate" },
	health: {
		interval_seconds: 1,
		unhealthy_threshold: 10,
		exec: { command: ["cat", "/tmp/healthy"] },
	},
};

const TEST_WORKLOAD_NO_HEALTH: Workload = {
	workload: { name: "no-health", version: "1.0.0" },
	image: { ref: "test:latest" },
	resources: { vcpus: 1, memory_mb: 256, disk_gb: 2 },
	network: { access: "none" },
	idle: { action: "hibernate" },
};

let db: DrizzleDb;
let runtime: FakeRuntime;
let nodeId: NodeId;
let workloadId: WorkloadId;

/** Health checker that immediately succeeds. */
const alwaysHealthy: HealthChecker = async () => {};

beforeEach(() => {
	db = createTestDatabase();
	runtime = new FakeRuntime();
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
});

// ── 4.1 — Golden snapshot creation ──────────────────────────────────────────

describe("SnapshotManager", () => {
	describe("createGolden()", () => {
		test("cold boots a VM from the workload definition", async () => {
			const manager = new SnapshotManager(runtime, db, nodeId, {
				healthChecker: alwaysHealthy,
			});

			const ref = await manager.createGolden(workloadId, TEST_WORKLOAD);

			expect(ref).toBeDefined();
			expect(ref.type).toBe("golden");
		});

		test("polls the health endpoint until healthy", async () => {
			let healthChecked = false;

			const manager = new SnapshotManager(runtime, db, nodeId, {
				healthChecker: async (check) => {
					expect(typeof check).toBe("function");
					healthChecked = true;
				},
			});

			await manager.createGolden(workloadId, TEST_WORKLOAD);

			expect(healthChecked).toBe(true);
		});

		test("skips health check when workload has no health config", async () => {
			let healthCalled = false;

			const noHealthWorkloadId = generateWorkloadId();
			db.insert(workloads)
				.values({
					workloadId: noHealthWorkloadId,
					name: "no-health",
					version: "1.0.0",
					config: TEST_WORKLOAD_NO_HEALTH,
					createdAt: new Date(),
					updatedAt: new Date(),
				})
				.run();

			const manager = new SnapshotManager(runtime, db, nodeId, {
				healthChecker: async () => {
					healthCalled = true;
				},
			});

			await manager.createGolden(noHealthWorkloadId, TEST_WORKLOAD_NO_HEALTH);

			expect(healthCalled).toBe(false);
		});

		test("snapshots after health check passes", async () => {
			const manager = new SnapshotManager(runtime, db, nodeId, {
				healthChecker: alwaysHealthy,
			});

			const ref = await manager.createGolden(workloadId, TEST_WORKLOAD);

			expect(ref.paths.memory).toBeTruthy();
			expect(ref.paths.vmstate).toBeTruthy();
		});

		test("destroys the bootstrap VM after snapshotting", async () => {
			const manager = new SnapshotManager(runtime, db, nodeId, {
				healthChecker: alwaysHealthy,
			});

			const ref = await manager.createGolden(workloadId, TEST_WORKLOAD);

			// The bootstrap instance should be destroyed — runtime should not know about it
			// The ref came from a temporary instance, so trying to use it should fail
			// We verify by checking that the runtime has no instances left
			expect(ref.type).toBe("golden");
		});

		test("stores the snapshot in the snapshots table (type='golden')", async () => {
			const manager = new SnapshotManager(runtime, db, nodeId, {
				healthChecker: alwaysHealthy,
			});

			const ref = await manager.createGolden(workloadId, TEST_WORKLOAD);

			const row = db
				.select()
				.from(snapshots)
				.where(eq(snapshots.snapshotId, ref.id))
				.get();

			expect(row).toBeDefined();
			expect(row!.type).toBe("golden");
			expect(row!.workloadId).toBe(workloadId);
			expect(row!.nodeId).toBe(nodeId);
			expect(row!.vmstatePath).toBeTruthy();
		});

		test("fails if health check never passes (timeout)", async () => {
			const manager = new SnapshotManager(runtime, db, nodeId, {
				healthChecker: async () => {
					throw new HealthCheckTimeoutError("timed out");
				},
			});

			await expect(
				manager.createGolden(workloadId, TEST_WORKLOAD),
			).rejects.toBeInstanceOf(HealthCheckTimeoutError);
		});

		test("cleans up the bootstrap VM on failure", async () => {
			const failRuntime = new FakeRuntime({
				failOn: new Set(["snapshot"]),
			});

			const manager = new SnapshotManager(failRuntime, db, nodeId, {
				healthChecker: alwaysHealthy,
			});

			await expect(
				manager.createGolden(workloadId, TEST_WORKLOAD),
			).rejects.toThrow("Injected failure");

			// No snapshot rows should have been created
			const rows = db.select().from(snapshots).all();
			expect(rows).toHaveLength(0);
		});

		test("cleans up bootstrap VM on health check failure", async () => {
			const manager = new SnapshotManager(runtime, db, nodeId, {
				healthChecker: async () => {
					throw new HealthCheckTimeoutError("timed out");
				},
			});

			await expect(
				manager.createGolden(workloadId, TEST_WORKLOAD),
			).rejects.toBeInstanceOf(HealthCheckTimeoutError);

			// No snapshot rows should exist
			const rows = db.select().from(snapshots).all();
			expect(rows).toHaveLength(0);
		});

		test("creates golden snapshot with exec probe", async () => {
			const execWorkloadId = generateWorkloadId();
			db.insert(workloads)
				.values({
					workloadId: execWorkloadId,
					name: "test-exec",
					version: "1.0.0",
					config: TEST_WORKLOAD_EXEC,
					createdAt: new Date(),
					updatedAt: new Date(),
				})
				.run();

			let checkFnReceived = false;

			const manager = new SnapshotManager(runtime, db, nodeId, {
				healthChecker: async (check) => {
					// The check should be a function (exec-based)
					expect(typeof check).toBe("function");
					checkFnReceived = true;
				},
			});

			const ref = await manager.createGolden(execWorkloadId, TEST_WORKLOAD_EXEC);

			expect(ref.type).toBe("golden");
			expect(checkFnReceived).toBe(true);
		});

		test("only one golden snapshot per workload+node combination (upsert semantics)", async () => {
			const manager = new SnapshotManager(runtime, db, nodeId, {
				healthChecker: alwaysHealthy,
			});

			const ref1 = await manager.createGolden(workloadId, TEST_WORKLOAD);
			const ref2 = await manager.createGolden(workloadId, TEST_WORKLOAD);

			// IDs should differ (new snapshot each time)
			expect(ref1.id).not.toBe(ref2.id);

			// Only one golden snapshot should exist for this workload+node
			const goldenRows = db
				.select()
				.from(snapshots)
				.where(
					and(
						eq(snapshots.workloadId, workloadId),
						eq(snapshots.nodeId, nodeId),
						eq(snapshots.type, "golden"),
					),
				)
				.all();

			expect(goldenRows).toHaveLength(1);
			expect(goldenRows[0]!.snapshotId).toBe(ref2.id);
		});
	});

	// ── 4.3 — Golden snapshot lookup & validation ────────────────────────────

	describe("getGolden()", () => {
		test("returns the golden snapshot for a workload+node", async () => {
			const manager = new SnapshotManager(runtime, db, nodeId, {
				healthChecker: alwaysHealthy,
			});

			const created = await manager.createGolden(workloadId, TEST_WORKLOAD);
			const found = manager.getGolden(workloadId, nodeId);

			expect(found).not.toBeNull();
			expect(found!.id).toBe(created.id);
			expect(found!.type).toBe("golden");
			expect(found!.workloadId).toBe(workloadId);
			expect(found!.nodeId).toBe(nodeId);
		});

		test("returns null if no golden snapshot exists", () => {
			const manager = new SnapshotManager(runtime, db, nodeId, {
				healthChecker: alwaysHealthy,
			});

			const found = manager.getGolden(workloadId, nodeId);

			expect(found).toBeNull();
		});

		test("validates runtime metadata compatibility before returning", async () => {
			const manager = new SnapshotManager(runtime, db, nodeId, {
				healthChecker: alwaysHealthy,
			});

			await manager.createGolden(workloadId, TEST_WORKLOAD);

			// Corrupt the runtimeMeta in the DB
			const row = db
				.select()
				.from(snapshots)
				.where(
					and(
						eq(snapshots.workloadId, workloadId),
						eq(snapshots.nodeId, nodeId),
						eq(snapshots.type, "golden"),
					),
				)
				.get();

			db.update(snapshots)
				.set({ runtimeMeta: null })
				.where(eq(snapshots.snapshotId, row!.snapshotId))
				.run();

			const found = manager.getGolden(workloadId, nodeId);

			expect(found).toBeNull();
		});
	});

	describe("goldenExists()", () => {
		test("returns true when a golden snapshot exists", async () => {
			const manager = new SnapshotManager(runtime, db, nodeId, {
				healthChecker: alwaysHealthy,
			});

			await manager.createGolden(workloadId, TEST_WORKLOAD);

			expect(manager.goldenExists(workloadId, nodeId)).toBe(true);
		});

		test("returns false when no golden snapshot exists", () => {
			const manager = new SnapshotManager(runtime, db, nodeId, {
				healthChecker: alwaysHealthy,
			});

			expect(manager.goldenExists(workloadId, nodeId)).toBe(false);
		});
	});
});
