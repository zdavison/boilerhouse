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
	claims,
	nodes,
	workloads,
} from "@boilerhouse/db";
import { InstanceManager } from "./instance-manager";
import { TenantDataStore } from "./tenant-data";
import { TenantManager } from "./tenant-manager";

const TEST_WORKLOAD_DESTROY: Workload = {
	workload: { name: "test-destroy", version: "1.0.0" },
	image: { ref: "test:latest" },
	resources: { vcpus: 1, memory_mb: 256, disk_gb: 2 },
	network: { access: "none" },
	idle: { action: "destroy" },
};

const TEST_WORKLOAD_HIBERNATE: Workload = {
	workload: { name: "test", version: "1.0.0" },
	image: { ref: "test:latest" },
	resources: { vcpus: 1, memory_mb: 256, disk_gb: 2 },
	network: { access: "none" },
	idle: { action: "hibernate" },
};

let db: DrizzleDb;
let runtime: FakeRuntime;
let log: ActivityLog;
let instanceManager: InstanceManager;
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
	tenantDataStore = new TenantDataStore(storagePath, db, runtime);
	tenantManager = new TenantManager(
		instanceManager,
		db,
		log,
		nodeId,
		tenantDataStore,
	);
});

describe("TenantManager", () => {
	describe("claim()", () => {
		test("no prior state → cold boots new instance (source: 'cold')", async () => {
			const tenantId = generateTenantId();

			const result = await tenantManager.claim(tenantId, workloadId);

			expect(result.source).toBe("cold");
			expect(result.instanceId).toBeTruthy();
			expect(result.tenantId).toBe(tenantId);
		});

		test("tenant has active instance → returns existing (source: 'existing')", async () => {
			const tenantId = generateTenantId();

			// First claim creates a fresh instance
			const first = await tenantManager.claim(tenantId, workloadId);
			expect(first.source).toBe("cold");

			// Second claim returns the existing instance
			const second = await tenantManager.claim(tenantId, workloadId);
			expect(second.source).toBe("existing");
			expect(second.instanceId).toBe(first.instanceId);
		});

		test("creates tenant row if none exists", async () => {
			const tenantId = generateTenantId();

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

		test("creates a claim row with instanceId on successful claim", async () => {
			const tenantId = generateTenantId();

			db.insert(tenants)
				.values({ tenantId, workloadId, createdAt: new Date() })
				.run();

			const result = await tenantManager.claim(tenantId, workloadId);

			const claimRow = db
				.select()
				.from(claims)
				.where(eq(claims.tenantId, tenantId))
				.get();

			expect(claimRow).toBeDefined();
			expect(claimRow!.instanceId).toBe(result.instanceId);
			expect(claimRow!.status).toBe("active");
		});

		test("sets tenantId on instance row", async () => {
			const tenantId = generateTenantId();

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

			const first = await tenantManager.claim(tenantId, workloadId);
			const second = await tenantManager.claim(tenantId, workloadId);

			expect(second.instanceId).toBe(first.instanceId);
			expect(second.source).toBe("existing");
		});

		test("exclusivity: concurrent claims return same instance (no duplicates)", async () => {
			const tenantId = generateTenantId();

			// Fire two claims concurrently — the second should not create a duplicate
			const [first, second] = await Promise.all([
				tenantManager.claim(tenantId, workloadId),
				tenantManager.claim(tenantId, workloadId),
			]);

			expect(first.instanceId).toBe(second.instanceId);
		});

		test("exclusivity: claim returns starting instance rather than creating duplicate", async () => {
			const tenantId = generateTenantId();

			// First claim creates the instance
			const first = await tenantManager.claim(tenantId, workloadId);

			// Manually set instance back to "starting" to simulate a slow start
			db.update(instances)
				.set({ status: "starting" })
				.where(eq(instances.instanceId, first.instanceId))
				.run();

			// Second claim should return the starting instance, not create a new one
			const second = await tenantManager.claim(tenantId, workloadId);

			expect(second.instanceId).toBe(first.instanceId);
			expect(second.source).toBe("existing");
		});

		test("concurrent claims from different tenants for same workload all succeed", async () => {
			const tenantList = Array.from({ length: 5 }, () => generateTenantId());

			// Fire all claims concurrently
			const results = await Promise.all(
				tenantList.map((tid) => tenantManager.claim(tid, workloadId)),
			);

			// Each tenant should get a distinct instance
			const instanceIds = results.map((r) => r.instanceId);
			expect(new Set(instanceIds).size).toBe(5);

			// All should succeed via cold boot
			for (const r of results) {
				expect(r.source).toBe("cold");
			}
		});

		test("returns endpoint with host + ports", async () => {
			const tenantId = generateTenantId();

			const result = await tenantManager.claim(tenantId, workloadId);

			expect(result.endpoint).not.toBeNull();
			expect(result.endpoint!.host).toBeTruthy();
			expect(result.endpoint!.ports.length).toBeGreaterThan(0);
		});

		test("response includes latencyMs >= 0", async () => {
			const tenantId = generateTenantId();

			const result = await tenantManager.claim(tenantId, workloadId);

			expect(result.latencyMs).toBeGreaterThanOrEqual(0);
		});

		test("logs 'tenant.claimed' activity with source in metadata", async () => {
			const tenantId = generateTenantId();

			await tenantManager.claim(tenantId, workloadId);

			const events = log.queryByTenant(tenantId);
			const claimEvent = events.find((e) => e.event === "tenant.claimed");
			expect(claimEvent).toBeDefined();
			expect(claimEvent!.tenantId).toBe(tenantId);
			expect(claimEvent!.metadata).toEqual(
				expect.objectContaining({ source: "cold" }),
			);
		});

		test("tenant data overlay exists → cold boot with data (source: 'cold+data')", async () => {
			const tenantId = generateTenantId();

			// Create tenant row with overlay
			db.insert(tenants)
				.values({ tenantId, workloadId, createdAt: new Date() })
				.run();

			// Save an overlay file
			const overlayDir = mkdtempSync(join(tmpdir(), "overlay-src-"));
			const overlayPath = join(overlayDir, "overlay.tar.gz");
			writeFileSync(overlayPath, "fake-data");
			tenantDataStore.saveOverlay(tenantId, workloadId, overlayPath);

			const result = await tenantManager.claim(tenantId, workloadId);
			expect(result.source).toBe("cold+data");
		});
	});

	describe("release()", () => {
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

			const destroyTenantManager = new TenantManager(
				instanceManager,
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

		test("release → instance destroyed", async () => {
			const tenantId = generateTenantId();

			const claimed = await tenantManager.claim(tenantId, workloadId);
			await tenantManager.release(tenantId);

			const row = db
				.select()
				.from(instances)
				.where(eq(instances.instanceId, claimed.instanceId))
				.get();

			expect(row!.status).toBe("destroyed");
		});

		test("deletes claim row on release", async () => {
			const tenantId = generateTenantId();

			await tenantManager.claim(tenantId, workloadId);
			await tenantManager.release(tenantId);

			const claimRow = db
				.select()
				.from(claims)
				.where(eq(claims.tenantId, tenantId))
				.get();

			// Claim is deleted after release; tenant identity row persists
			expect(claimRow).toBeUndefined();

			const tenantRow = db
				.select()
				.from(tenants)
				.where(eq(tenants.tenantId, tenantId))
				.get();
			expect(tenantRow).toBeDefined();
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
