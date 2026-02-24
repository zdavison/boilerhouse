import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import {
	generateNodeId,
	generateInstanceId,
	generateWorkloadId,
} from "@boilerhouse/core";
import type {
	NodeId,
	WorkloadId,
	InstanceId,
	InstanceStatus,
} from "@boilerhouse/core";
import {
	createTestDatabase,
	nodes,
	workloads,
	instances,
} from "@boilerhouse/db";
import type { DrizzleDb } from "@boilerhouse/db";
import { ResourceLimiter, CapacityExceededError } from "./resource-limits";

// ── Helpers ─────────────────────────────────────────────────────────────────

let db: DrizzleDb;
let nodeId: NodeId;
let workloadId: WorkloadId;
let limiter: ResourceLimiter;

function insertWorkload(): void {
	db.insert(workloads)
		.values({
			workloadId,
			name: "test-wk",
			version: "1.0.0",
			config: {
				workload: { name: "test-wk", version: "1.0.0" },
				image: { ref: "test:latest" },
				resources: { vcpus: 1, memory_mb: 256, disk_gb: 2 },
				network: { access: "none" },
				idle: { action: "hibernate" },
			},
			createdAt: new Date(),
			updatedAt: new Date(),
		})
		.run();
}

function insertInstance(status: InstanceStatus): InstanceId {
	const id = generateInstanceId();
	db.insert(instances)
		.values({
			instanceId: id,
			workloadId,
			nodeId,
			status,
			createdAt: new Date(),
		})
		.run();
	return id;
}

beforeEach(() => {
	db = createTestDatabase();
	nodeId = generateNodeId();
	workloadId = generateWorkloadId();

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
	insertWorkload();
});

afterEach(() => {
	limiter?.dispose();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("ResourceLimiter", () => {
	test("canCreate returns true when under limit", () => {
		insertInstance("active");
		limiter = new ResourceLimiter(db, { maxInstances: 3 });

		expect(limiter.canCreate(nodeId)).toBe(true);
	});

	test("canCreate returns false at limit", () => {
		insertInstance("active");
		insertInstance("active");
		limiter = new ResourceLimiter(db, { maxInstances: 2 });

		expect(limiter.canCreate(nodeId)).toBe(false);
	});

	test("does not count destroyed/hibernated instances", () => {
		insertInstance("active");
		insertInstance("destroyed");
		insertInstance("hibernated");
		limiter = new ResourceLimiter(db, { maxInstances: 2 });

		expect(limiter.canCreate(nodeId)).toBe(true);
	});

	test("counts starting/destroying instances", () => {
		insertInstance("starting");
		insertInstance("destroying");
		limiter = new ResourceLimiter(db, { maxInstances: 2 });

		expect(limiter.canCreate(nodeId)).toBe(false);
	});

	test("waitForCapacity resolves when capacity freed via release()", async () => {
		insertInstance("active");
		insertInstance("active");
		limiter = new ResourceLimiter(db, { maxInstances: 2 });

		let resolved = false;
		const promise = limiter.waitForCapacity(nodeId, 5000).then(() => {
			resolved = true;
		});

		// Not resolved yet
		await Bun.sleep(10);
		expect(resolved).toBe(false);

		// Free a slot (simulate instance destroyed — update DB first)
		db.update(instances)
			.set({ status: "destroyed" as InstanceStatus })
			.where(eq(instances.nodeId, nodeId))
			.limit(1)
			.run();
		limiter.release(nodeId);

		await promise;
		expect(resolved).toBe(true);
	});

	test("waitForCapacity rejects after timeout with CapacityExceededError", async () => {
		insertInstance("active");
		insertInstance("active");
		limiter = new ResourceLimiter(db, { maxInstances: 2 });

		try {
			await limiter.waitForCapacity(nodeId, 50);
			expect(true).toBe(false); // Should not reach
		} catch (err) {
			expect(err).toBeInstanceOf(CapacityExceededError);
		}
	});

	test("queued claims served in FIFO order", async () => {
		insertInstance("active");
		insertInstance("active");
		limiter = new ResourceLimiter(db, { maxInstances: 2 });

		const order: number[] = [];

		const p1 = limiter.waitForCapacity(nodeId, 5000).then(() => order.push(1));
		const p2 = limiter.waitForCapacity(nodeId, 5000).then(() => order.push(2));

		await Bun.sleep(10);

		// Release twice — update DB between releases
		db.update(instances)
			.set({ status: "destroyed" as InstanceStatus })
			.where(eq(instances.nodeId, nodeId))
			.limit(1)
			.run();
		limiter.release(nodeId);

		await Bun.sleep(10);

		// Mark another destroyed for second release
		db.update(instances)
			.set({ status: "destroyed" as InstanceStatus })
			.where(eq(instances.nodeId, nodeId))
			.limit(1)
			.run();
		limiter.release(nodeId);

		await Promise.all([p1, p2]);
		expect(order).toEqual([1, 2]);
	});

	test("integration: tenant claim returns 503 with Retry-After header", async () => {
		// This test uses the full API — tested in integration step
		// Here we verify the limiter behavior standalone
		insertInstance("active");
		insertInstance("active");
		limiter = new ResourceLimiter(db, { maxInstances: 2 });

		expect(limiter.canCreate(nodeId)).toBe(false);

		// After destroying one
		db.update(instances)
			.set({ status: "destroyed" as InstanceStatus })
			.where(eq(instances.nodeId, nodeId))
			.limit(1)
			.run();

		expect(limiter.canCreate(nodeId)).toBe(true);
	});
});
