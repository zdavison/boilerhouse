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
	ActivityLog,
	instances,
	nodes,
	workloads,
} from "@boilerhouse/db";
import { InstanceManager } from "./instance-manager";
import { TenantDataStore } from "./tenant-data";
import { TenantManager } from "./tenant-manager";
import { IdleMonitor } from "./idle-monitor";

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
let log: ActivityLog;
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
	log = new ActivityLog(db);
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

	instanceManager = new InstanceManager(runtime, db, log, nodeId);
	tenantDataStore = new TenantDataStore(storagePath, db, runtime);
	idleMonitor = new IdleMonitor({ defaultPollIntervalMs: POLL_INTERVAL });

	tenantManager = new TenantManager(
		instanceManager,
		db,
		log,
		nodeId,
		tenantDataStore,
		idleMonitor,
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
