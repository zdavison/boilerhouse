import { describe, test, expect, beforeEach } from "bun:test";
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
	instances,
	workloads,
	nodes,
} from "@boilerhouse/db";
import { eq } from "drizzle-orm";
import { PoolManager } from "./pool-manager";
import type { HealthChecker } from "./health-check";

const alwaysHealthy: HealthChecker = async () => {};

const TEST_WORKLOAD_NO_HEALTH: Workload = {
	workload: { name: "test-pool", version: "1.0.0" },
	image: { ref: "test:latest" },
	resources: { vcpus: 1, memory_mb: 256, disk_gb: 2 },
	network: { access: "none" },
	idle: { action: "destroy" },
	pool: { size: 2, max_fill_concurrency: 2 },
};

const TEST_WORKLOAD_WITH_EXEC_HEALTH: Workload = {
	workload: { name: "test-pool-health", version: "1.0.0" },
	image: { ref: "test:latest" },
	resources: { vcpus: 1, memory_mb: 256, disk_gb: 2 },
	network: { access: "none" },
	idle: { action: "destroy" },
	pool: { size: 2, max_fill_concurrency: 2 },
	health: {
		interval_seconds: 0.01,
		unhealthy_threshold: 3,
		exec: { command: ["cat", "/tmp/healthy"] },
	},
};

let db: DrizzleDb;
let runtime: FakeRuntime;
let nodeId: NodeId;
let workloadId: WorkloadId;
let poolManager: PoolManager;

beforeEach(() => {
	db = createTestDatabase();
	runtime = new FakeRuntime();
	nodeId = generateNodeId();
	workloadId = generateWorkloadId();

	db.insert(nodes).values({
		nodeId,
		runtimeType: "podman",
		capacity: { vcpus: 8, memoryMb: 16384, diskGb: 100 },
		status: "online",
		lastHeartbeat: new Date(),
		createdAt: new Date(),
	}).run();

	db.insert(workloads).values({
		workloadId,
		name: "test-pool",
		version: "1.0.0",
		config: TEST_WORKLOAD_NO_HEALTH,
		status: "creating",
		createdAt: new Date(),
		updatedAt: new Date(),
	}).run();

	poolManager = new PoolManager(runtime, db, nodeId, { healthChecker: alwaysHealthy });
});

describe("PoolManager", () => {
	describe("prime()", () => {
		test("creates a pool instance with poolStatus=ready and transitions workload to ready", async () => {
			await poolManager.prime(workloadId);

			const inst = db.select().from(instances).where(eq(instances.workloadId, workloadId)).get();
			expect(inst).toBeDefined();
			expect(inst!.poolStatus).toBe("ready");
			expect(inst!.status).toBe("active");

			const wl = db.select().from(workloads).where(eq(workloads.workloadId, workloadId)).get();
			expect(wl!.status).toBe("ready");
		});

		test("destroys instance and removes DB row on health check failure", async () => {
			const workloadId2 = generateWorkloadId();
			db.insert(workloads).values({
				workloadId: workloadId2,
				name: "test-pool-health",
				version: "1.0.0",
				config: TEST_WORKLOAD_WITH_EXEC_HEALTH,
				status: "creating",
				createdAt: new Date(),
				updatedAt: new Date(),
			}).run();

			const failingHealthChecker: HealthChecker = async () => {
				throw new Error("Health check failed");
			};
			const failingPm = new PoolManager(runtime, db, nodeId, { healthChecker: failingHealthChecker });

			await expect(failingPm.prime(workloadId2)).rejects.toThrow("Health check failed");

			// No instances should remain in DB for this workload
			const remaining = db.select().from(instances).where(eq(instances.workloadId, workloadId2)).all();
			expect(remaining).toHaveLength(0);
		});

		test("throws when workload not found", async () => {
			const badId = generateWorkloadId();
			await expect(poolManager.prime(badId)).rejects.toThrow("Workload not found");
		});
	});

	describe("acquire()", () => {
		test("returns ready instance and marks it acquired", async () => {
			await poolManager.prime(workloadId);

			const handle = await poolManager.acquire(workloadId);
			expect(handle.running).toBe(true);

			const inst = db.select().from(instances).where(eq(instances.instanceId, handle.instanceId)).get();
			expect(inst!.poolStatus).toBe("acquired");
		});

		test("cold-boots a new instance when pool is empty", async () => {
			// No prime — pool is empty
			const handle = await poolManager.acquire(workloadId);
			expect(handle.running).toBe(true);

			const inst = db.select().from(instances).where(eq(instances.instanceId, handle.instanceId)).get();
			expect(inst!.poolStatus).toBe("acquired");
		});

		test("throws when workload not found (cold boot path)", async () => {
			const badId = generateWorkloadId();
			await expect(poolManager.acquire(badId)).rejects.toThrow("Workload not found");
		});
	});

	describe("replenish()", () => {
		test("starts instances up to target pool size", async () => {
			// Pool starts empty
			await poolManager.replenish(workloadId);

			const poolInstances = db.select().from(instances)
				.where(eq(instances.workloadId, workloadId))
				.all();

			// max_fill_concurrency is 2, size is 2 → should start 2
			expect(poolInstances.length).toBeGreaterThanOrEqual(1);
		});

		test("does not add instances when pool is already full", async () => {
			// Prime fills pool to size=2 (one instance), then replenish to fill remainder
			await poolManager.prime(workloadId);
			// Now there's 1 ready instance, pool size is 2 → replenish starts 1 more
			await poolManager.replenish(workloadId);
			await poolManager.replenish(workloadId); // should be a no-op (pool full)

			const poolInstances = db.select().from(instances)
				.where(eq(instances.workloadId, workloadId))
				.all()
				.filter((r) => r.poolStatus === "warming" || r.poolStatus === "ready");

			expect(poolInstances.length).toBeLessThanOrEqual(2);
		});

		test("no-op when workload not found", async () => {
			const badId = generateWorkloadId();
			await expect(poolManager.replenish(badId)).resolves.toBeUndefined();
		});
	});

	describe("drain()", () => {
		test("destroys all warming and ready pool instances", async () => {
			await poolManager.prime(workloadId);
			await poolManager.replenish(workloadId);

			await poolManager.drain(workloadId);

			const remaining = db.select().from(instances)
				.where(eq(instances.workloadId, workloadId))
				.all()
				.filter((r) => r.poolStatus === "warming" || r.poolStatus === "ready");

			expect(remaining).toHaveLength(0);
		});

		test("does not destroy acquired instances", async () => {
			await poolManager.prime(workloadId);
			const handle = await poolManager.acquire(workloadId);

			await poolManager.drain(workloadId);

			const acquired = db.select().from(instances)
				.where(eq(instances.instanceId, handle.instanceId))
				.get();

			// Acquired instance should still have poolStatus="acquired" and not be destroyed
			expect(acquired!.poolStatus).toBe("acquired");
			expect(acquired!.status).not.toBe("destroyed");
		});
	});
});
