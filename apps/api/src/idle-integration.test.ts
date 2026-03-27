import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import {
	type WorkloadId,
	type NodeId,
	type Workload,
	FakeRuntime,
	generateWorkloadId,
	generateNodeId,
	generateTenantId,
} from "@boilerhouse/core";
import {
	createTestDatabase,
	type DrizzleDb,
	instances,
	nodes,
	workloads,
} from "@boilerhouse/db";
import { InstanceManager } from "./instance-manager";
import { TenantDataStore } from "./tenant-data";
import { TenantManager } from "./tenant-manager";
import { IdleMonitor } from "./idle-monitor";
import { createTestAudit } from "./test-helpers";

const POLL_INTERVAL = 25;

const TEST_WORKLOAD_HIBERNATE: Workload = {
	workload: { name: "idle-test", version: "1.0.0" },
	image: { ref: "test:latest" },
	resources: { vcpus: 1, memory_mb: 256, disk_gb: 2 },
	network: { access: "none" },
	idle: { action: "hibernate", timeout_seconds: 0.05 },
};

const TEST_WORKLOAD_DESTROY: Workload = {
	workload: { name: "idle-test-destroy", version: "1.0.0" },
	image: { ref: "test:latest" },
	resources: { vcpus: 1, memory_mb: 256, disk_gb: 2 },
	network: { access: "none" },
	idle: { action: "destroy", timeout_seconds: 0.05 },
};

let db: DrizzleDb;
let runtime: FakeRuntime;
let instanceManager: InstanceManager;
let tenantDataStore: TenantDataStore;
let tenantManager: TenantManager;
let idleMonitor: IdleMonitor;
let nodeId: NodeId;
let storagePath: string;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function seedWorkload(id: WorkloadId, workload: Workload): void {
	db.insert(workloads)
		.values({
			workloadId: id,
			name: workload.workload.name,
			version: workload.workload.version,
			config: workload,
			createdAt: new Date(),
			updatedAt: new Date(),
		})
		.run();
}

beforeEach(() => {
	db = createTestDatabase();
	runtime = new FakeRuntime();
	nodeId = generateNodeId();
	storagePath = mkdtempSync(join(tmpdir(), "idle-int-test-"));

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

	const audit = createTestAudit(db, nodeId);
	instanceManager = new InstanceManager(runtime, db, audit, nodeId);
	tenantDataStore = new TenantDataStore(storagePath, db, runtime);
	idleMonitor = new IdleMonitor({ defaultPollIntervalMs: POLL_INTERVAL });

	tenantManager = new TenantManager(
		instanceManager,
		db,
		audit,
		nodeId,
		tenantDataStore,
		{ idleMonitor },
	);

	// Wire up the idle handler to release the tenant
	idleMonitor.onIdle(async (instanceId, _action) => {
		const instanceRow = db
			.select()
			.from(instances)
			.where(eq(instances.instanceId, instanceId))
			.get();
		if (instanceRow?.tenantId) {
			await tenantManager.release(instanceRow.tenantId, instanceRow.workloadId);
		}
	});
});

afterEach(() => {
	idleMonitor.stop();
});

describe("IdleMonitor + TenantManager integration", () => {
	test("idle fires → instance is destroyed", async () => {
		const workloadId = generateWorkloadId();
		seedWorkload(workloadId, TEST_WORKLOAD_HIBERNATE);

		const tenantId = generateTenantId();
		const result = await tenantManager.claim(tenantId, workloadId);

		// Wait for idle timeout (50ms) + margin
		await sleep(80);

		const row = db
			.select()
			.from(instances)
			.where(eq(instances.instanceId, result.instanceId))
			.get();

		expect(row!.status).toBe("destroyed");
	});

	test("idle fires 'destroy' → instance status becomes 'destroyed'", async () => {
		const workloadId = generateWorkloadId();
		seedWorkload(workloadId, TEST_WORKLOAD_DESTROY);

		const tenantId = generateTenantId();
		const result = await tenantManager.claim(tenantId, workloadId);

		// Wait for idle timeout (50ms) + margin
		await sleep(80);

		const row = db
			.select()
			.from(instances)
			.where(eq(instances.instanceId, result.instanceId))
			.get();

		expect(row!.status).toBe("destroyed");
	});

	test("claim then immediately release → idle handler does NOT fire", async () => {
		const workloadId = generateWorkloadId();
		seedWorkload(workloadId, TEST_WORKLOAD_HIBERNATE);

		const tenantId = generateTenantId();
		const result = await tenantManager.claim(tenantId, workloadId);
		await tenantManager.release(tenantId, workloadId);

		// Instance is already destroyed by explicit release
		const beforeRow = db
			.select()
			.from(instances)
			.where(eq(instances.instanceId, result.instanceId))
			.get();
		expect(beforeRow!.status).toBe("destroyed");

		// Wait past the idle timeout — handler should NOT fire (unwatch prevented it)
		await sleep(80);

		// Status should still be destroyed (not double-processed)
		const afterRow = db
			.select()
			.from(instances)
			.where(eq(instances.instanceId, result.instanceId))
			.get();
		expect(afterRow!.status).toBe("destroyed");
	});

	test("re-claiming an existing instance resets the idle timeout", async () => {
		// Use a workload with 100ms idle timeout
		const workload: Workload = {
			workload: { name: "idle-reclaim", version: "1.0.0" },
			image: { ref: "test:latest" },
			resources: { vcpus: 1, memory_mb: 256, disk_gb: 2 },
			network: { access: "none" },
			idle: { action: "destroy", timeout_seconds: 0.1 },
		};

		const workloadId = generateWorkloadId();
		seedWorkload(workloadId, workload);

		const tenantId = generateTenantId();
		const first = await tenantManager.claim(tenantId, workloadId);

		// Wait 70ms (past halfway but before the 100ms timeout)
		await sleep(70);

		// Re-claim the same tenant+workload — should reset the idle timer
		const second = await tenantManager.claim(tenantId, workloadId);
		expect(second.source).toBe("existing");
		expect(second.instanceId).toBe(first.instanceId);

		// At 70ms after re-claim, instance should still be active
		// (original timer would have fired at ~30ms from now without the reset)
		await sleep(70);
		const midRow = db
			.select()
			.from(instances)
			.where(eq(instances.instanceId, first.instanceId))
			.get();
		expect(midRow!.status).toBe("active");

		// After the full 100ms timeout from the re-claim, it should be destroyed
		await sleep(60);
		const afterRow = db
			.select()
			.from(instances)
			.where(eq(instances.instanceId, first.instanceId))
			.get();
		expect(afterRow!.status).toBe("destroyed");
	});

	test("workload's idle config (timeout_seconds, action) is used by the monitor", async () => {
		// Use a workload with a longer timeout to verify it's read from config
		const longTimeoutWorkload: Workload = {
			workload: { name: "idle-long", version: "1.0.0" },
			image: { ref: "test:latest" },
			resources: { vcpus: 1, memory_mb: 256, disk_gb: 2 },
			network: { access: "none" },
			idle: { action: "destroy", timeout_seconds: 0.15 },
		};

		const workloadId = generateWorkloadId();
		seedWorkload(workloadId, longTimeoutWorkload);

		const tenantId = generateTenantId();
		const result = await tenantManager.claim(tenantId, workloadId);

		// At 80ms the instance should still be active (timeout is 150ms)
		await sleep(80);
		const midRow = db
			.select()
			.from(instances)
			.where(eq(instances.instanceId, result.instanceId))
			.get();
		expect(midRow!.status).toBe("active");

		// At 200ms it should have fired
		await sleep(100);
		const afterRow = db
			.select()
			.from(instances)
			.where(eq(instances.instanceId, result.instanceId))
			.get();
		expect(afterRow!.status).toBe("destroyed");
	});
});
