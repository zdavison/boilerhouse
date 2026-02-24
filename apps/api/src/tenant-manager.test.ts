import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
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
	tenants,
	nodes,
	workloads,
} from "@boilerhouse/db";
import { InstanceManager } from "./instance-manager";
import { SnapshotManager } from "./snapshot-manager";
import type { HealthChecker } from "./snapshot-manager";
import { TenantDataStore } from "./tenant-data";
import { TenantManager, NoGoldenSnapshotError } from "./tenant-manager";

const TEST_WORKLOAD_HIBERNATE: Workload = {
	workload: { name: "test", version: "1.0.0" },
	image: { ref: "test:latest" },
	resources: { vcpus: 1, memory_mb: 256, disk_gb: 2 },
	network: { access: "none" },
	idle: { action: "hibernate" },
};

const TEST_WORKLOAD_DESTROY: Workload = {
	workload: { name: "test-destroy", version: "1.0.0" },
	image: { ref: "test:latest" },
	resources: { vcpus: 1, memory_mb: 256, disk_gb: 2 },
	network: { access: "none" },
	idle: { action: "destroy" },
};

const alwaysHealthy: HealthChecker = async () => {};

let db: DrizzleDb;
let runtime: FakeRuntime;
let log: ActivityLog;
let instanceManager: InstanceManager;
let snapshotManager: SnapshotManager;
let tenantDataStore: TenantDataStore;
let tenantManager: TenantManager;
let nodeId: NodeId;
let workloadId: WorkloadId;
let storagePath: string;

beforeEach(() => {
	db = createTestDatabase();
	runtime = new FakeRuntime();
	log = new ActivityLog(db);
	nodeId = generateNodeId();
	workloadId = generateWorkloadId();
	storagePath = mkdtempSync(join(tmpdir(), "tenant-mgr-test-"));

	// Seed FK rows
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
			config: TEST_WORKLOAD_HIBERNATE,
			createdAt: new Date(),
			updatedAt: new Date(),
		})
		.run();

	instanceManager = new InstanceManager(runtime, db, log, nodeId);
	snapshotManager = new SnapshotManager(runtime, db, nodeId, {
		healthChecker: alwaysHealthy,
	});
	tenantDataStore = new TenantDataStore(storagePath, db);
	tenantManager = new TenantManager(
		instanceManager,
		snapshotManager,
		db,
		log,
		nodeId,
		tenantDataStore,
	);
});

describe("TenantManager", () => {
	describe("claim()", () => {
		test("tenant has active instance → returns existing (source: 'existing')", async () => {
			const tenantId = generateTenantId();

			// Create golden snapshot first
			await snapshotManager.createGolden(workloadId, TEST_WORKLOAD_HIBERNATE);

			// First claim creates a fresh instance
			const first = await tenantManager.claim(tenantId, workloadId);
			expect(first.source).toBe("golden");

			// Second claim returns the existing instance
			const second = await tenantManager.claim(tenantId, workloadId);
			expect(second.source).toBe("existing");
			expect(second.instanceId).toBe(first.instanceId);
		});

		test("tenant snapshot exists (lastSnapshotId) → hot restore (source: 'snapshot')", async () => {
			const tenantId = generateTenantId();

			// Create golden, claim, then release (hibernate creates a tenant snapshot)
			await snapshotManager.createGolden(workloadId, TEST_WORKLOAD_HIBERNATE);
			await tenantManager.claim(tenantId, workloadId);
			await tenantManager.release(tenantId);

			// Verify tenant has a lastSnapshotId
			const tenantRow = db
				.select()
				.from(tenants)
				.where(eq(tenants.tenantId, tenantId))
				.get();
			expect(tenantRow!.lastSnapshotId).toBeTruthy();

			// Re-claim should restore from tenant snapshot
			const result = await tenantManager.claim(tenantId, workloadId);
			expect(result.source).toBe("snapshot");
		});

		test("tenant data overlay exists → cold restore from golden (source: 'cold+data')", async () => {
			const tenantId = generateTenantId();

			// Create golden snapshot
			await snapshotManager.createGolden(workloadId, TEST_WORKLOAD_HIBERNATE);

			// Create tenant row with overlay but no snapshot
			db.insert(tenants)
				.values({ tenantId, workloadId, createdAt: new Date() })
				.run();

			// Save an overlay file
			const overlayDir = mkdtempSync(join(tmpdir(), "overlay-src-"));
			const overlayPath = join(overlayDir, "overlay.ext4");
			writeFileSync(overlayPath, "fake-data");
			tenantDataStore.saveOverlay(tenantId, workloadId, overlayPath);

			const result = await tenantManager.claim(tenantId, workloadId);
			expect(result.source).toBe("cold+data");
		});

		test("no prior state → fresh from golden (source: 'golden')", async () => {
			const tenantId = generateTenantId();

			await snapshotManager.createGolden(workloadId, TEST_WORKLOAD_HIBERNATE);

			const result = await tenantManager.claim(tenantId, workloadId);
			expect(result.source).toBe("golden");
		});

		test("no golden snapshot → throws NoGoldenSnapshotError", async () => {
			const tenantId = generateTenantId();

			await expect(
				tenantManager.claim(tenantId, workloadId),
			).rejects.toBeInstanceOf(NoGoldenSnapshotError);
		});

		test("creates tenant row if none exists", async () => {
			const tenantId = generateTenantId();

			await snapshotManager.createGolden(workloadId, TEST_WORKLOAD_HIBERNATE);

			// No tenant row exists yet
			const before = db
				.select()
				.from(tenants)
				.where(eq(tenants.tenantId, tenantId))
				.get();
			expect(before).toBeUndefined();

			await tenantManager.claim(tenantId, workloadId);

			const after = db
				.select()
				.from(tenants)
				.where(eq(tenants.tenantId, tenantId))
				.get();
			expect(after).toBeDefined();
			expect(after!.workloadId).toBe(workloadId);
		});

		test("updates tenant row if exists (sets instanceId)", async () => {
			const tenantId = generateTenantId();

			db.insert(tenants)
				.values({ tenantId, workloadId, createdAt: new Date() })
				.run();

			await snapshotManager.createGolden(workloadId, TEST_WORKLOAD_HIBERNATE);
			const result = await tenantManager.claim(tenantId, workloadId);

			const row = db
				.select()
				.from(tenants)
				.where(eq(tenants.tenantId, tenantId))
				.get();

			expect(row!.instanceId).toBe(result.instanceId);
		});

		test("sets tenantId on instance row", async () => {
			const tenantId = generateTenantId();

			await snapshotManager.createGolden(workloadId, TEST_WORKLOAD_HIBERNATE);
			const result = await tenantManager.claim(tenantId, workloadId);

			const row = db
				.select()
				.from(instances)
				.where(eq(instances.instanceId, result.instanceId))
				.get();

			expect(row!.tenantId).toBe(tenantId);
		});

		test("exclusivity: second claim returns same instance", async () => {
			const tenantId = generateTenantId();

			await snapshotManager.createGolden(workloadId, TEST_WORKLOAD_HIBERNATE);

			const first = await tenantManager.claim(tenantId, workloadId);
			const second = await tenantManager.claim(tenantId, workloadId);

			expect(second.instanceId).toBe(first.instanceId);
			expect(second.source).toBe("existing");
		});

		test("returns endpoint with host + ports", async () => {
			const tenantId = generateTenantId();

			await snapshotManager.createGolden(workloadId, TEST_WORKLOAD_HIBERNATE);
			const result = await tenantManager.claim(tenantId, workloadId);

			expect(result.endpoint.host).toBeTruthy();
			expect(result.endpoint.ports.length).toBeGreaterThan(0);
		});

		test("response includes latencyMs >= 0", async () => {
			const tenantId = generateTenantId();

			await snapshotManager.createGolden(workloadId, TEST_WORKLOAD_HIBERNATE);
			const result = await tenantManager.claim(tenantId, workloadId);

			expect(result.latencyMs).toBeGreaterThanOrEqual(0);
		});

		test("logs 'tenant.claimed' activity with source in metadata", async () => {
			const tenantId = generateTenantId();

			await snapshotManager.createGolden(workloadId, TEST_WORKLOAD_HIBERNATE);
			await tenantManager.claim(tenantId, workloadId);

			const events = log.queryByTenant(tenantId);
			const claimEvent = events.find((e) => e.event === "tenant.claimed");
			expect(claimEvent).toBeDefined();
			expect(claimEvent!.tenantId).toBe(tenantId);
			expect(claimEvent!.metadata).toEqual(
				expect.objectContaining({ source: "golden" }),
			);
		});
	});

	describe("release()", () => {
		test("idle.action='hibernate' → instance hibernated, snapshot created", async () => {
			const tenantId = generateTenantId();

			await snapshotManager.createGolden(workloadId, TEST_WORKLOAD_HIBERNATE);
			const claimed = await tenantManager.claim(tenantId, workloadId);
			await tenantManager.release(tenantId);

			const row = db
				.select()
				.from(instances)
				.where(eq(instances.instanceId, claimed.instanceId))
				.get();

			expect(row!.status).toBe("hibernated");
		});

		test("idle.action='destroy' → instance destroyed", async () => {
			const destroyWorkloadId = generateWorkloadId();
			db.insert(workloads)
				.values({
					workloadId: destroyWorkloadId,
					name: "test-destroy",
					version: "1.0.0",
					config: TEST_WORKLOAD_DESTROY,
					createdAt: new Date(),
					updatedAt: new Date(),
				})
				.run();

			// Create golden for the destroy workload
			await snapshotManager.createGolden(
				destroyWorkloadId,
				TEST_WORKLOAD_DESTROY,
			);

			const destroyTenantManager = new TenantManager(
				instanceManager,
				snapshotManager,
				db,
				log,
				nodeId,
				tenantDataStore,
			);

			const tenantId = generateTenantId();
			const claimed = await destroyTenantManager.claim(tenantId, destroyWorkloadId);
			await destroyTenantManager.release(tenantId);

			const row = db
				.select()
				.from(instances)
				.where(eq(instances.instanceId, claimed.instanceId))
				.get();

			expect(row!.status).toBe("destroyed");
		});

		test("clears instanceId on tenant row", async () => {
			const tenantId = generateTenantId();

			await snapshotManager.createGolden(workloadId, TEST_WORKLOAD_HIBERNATE);
			await tenantManager.claim(tenantId, workloadId);
			await tenantManager.release(tenantId);

			const row = db
				.select()
				.from(tenants)
				.where(eq(tenants.tenantId, tenantId))
				.get();

			expect(row!.instanceId).toBeNull();
		});

		test("preserves lastSnapshotId on tenant row after hibernate", async () => {
			const tenantId = generateTenantId();

			await snapshotManager.createGolden(workloadId, TEST_WORKLOAD_HIBERNATE);
			await tenantManager.claim(tenantId, workloadId);
			await tenantManager.release(tenantId);

			const row = db
				.select()
				.from(tenants)
				.where(eq(tenants.tenantId, tenantId))
				.get();

			expect(row!.lastSnapshotId).toBeTruthy();
		});

		test("no active instance → no-op (no throw)", async () => {
			const tenantId = generateTenantId();

			db.insert(tenants)
				.values({ tenantId, workloadId, createdAt: new Date() })
				.run();

			// Should not throw
			await expect(tenantManager.release(tenantId)).resolves.toBeUndefined();
		});

		test("logs 'tenant.released' activity", async () => {
			const tenantId = generateTenantId();

			await snapshotManager.createGolden(workloadId, TEST_WORKLOAD_HIBERNATE);
			await tenantManager.claim(tenantId, workloadId);
			await tenantManager.release(tenantId);

			const events = log.queryByTenant(tenantId);
			const releaseEvent = events.find(
				(e) => e.event === "tenant.released",
			);
			expect(releaseEvent).toBeDefined();
			expect(releaseEvent!.tenantId).toBe(tenantId);
		});
	});
});
