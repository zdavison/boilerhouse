import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import {
	type WorkloadId,
	type NodeId,
	type TenantId,
	FakeRuntime,
	generateWorkloadId,
	generateNodeId,
	generateTenantId,
	generateInstanceId,
} from "@boilerhouse/core";
import {
	createTestDatabase,
	type DrizzleDb,
	tenants,
	nodes,
	workloads,
	instances,
} from "@boilerhouse/db";
import { TenantDataStore } from "./tenant-data";

let db: DrizzleDb;
let runtime: FakeRuntime;
let storagePath: string;
let store: TenantDataStore;
let nodeId: NodeId;
let workloadId: WorkloadId;
let tenantId: TenantId;
let overlaySourceDir: string;

beforeEach(() => {
	db = createTestDatabase();
	runtime = new FakeRuntime();
	storagePath = mkdtempSync(join(tmpdir(), "tenant-data-test-"));
	overlaySourceDir = mkdtempSync(join(tmpdir(), "tenant-overlay-src-"));
	store = new TenantDataStore(storagePath, db, runtime);

	nodeId = generateNodeId();
	workloadId = generateWorkloadId();
	tenantId = generateTenantId();

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
			config: {
				workload: { name: "test", version: "1.0.0" },
				image: { ref: "test:latest" },
				resources: { vcpus: 1, memory_mb: 256, disk_gb: 2 },
				network: { access: "none" },
				idle: { action: "hibernate" },
			},
			createdAt: new Date(),
			updatedAt: new Date(),
		})
		.run();

	db.insert(tenants)
		.values({
			tenantId,
			workloadId,
			createdAt: new Date(),
		})
		.run();
});

describe("TenantDataStore", () => {
	describe("saveOverlay()", () => {
		test("copies overlay archive to {storagePath}/{tenantId}/{workloadId}/overlay.tar.gz", async () => {
			const srcPath = join(overlaySourceDir, "overlay.tar.gz");
			writeFileSync(srcPath, "fake-overlay-data");

			await store.saveOverlay(tenantId, workloadId, srcPath);

			const destPath = join(storagePath, tenantId, workloadId, "overlay.tar.gz");
			expect(existsSync(destPath)).toBe(true);
			expect(readFileSync(destPath, "utf-8")).toBe("fake-overlay-data");
		});

		test("records dataOverlayRef on tenant row", async () => {
			const srcPath = join(overlaySourceDir, "overlay.tar.gz");
			writeFileSync(srcPath, "fake-overlay-data");

			await store.saveOverlay(tenantId, workloadId, srcPath);

			const row = db
				.select()
				.from(tenants)
				.where(eq(tenants.tenantId, tenantId))
				.get();

			expect(row!.dataOverlayRef).toBeDefined();
		});

		test("overwrites previous overlay for same tenant+workload", async () => {
			const srcPath1 = join(overlaySourceDir, "overlay1.ext4");
			writeFileSync(srcPath1, "first-version");
			await store.saveOverlay(tenantId, workloadId, srcPath1);

			const srcPath2 = join(overlaySourceDir, "overlay2.ext4");
			writeFileSync(srcPath2, "second-version");
			await store.saveOverlay(tenantId, workloadId, srcPath2);

			const destPath = join(storagePath, tenantId, workloadId, "overlay.tar.gz");
			expect(readFileSync(destPath, "utf-8")).toBe("second-version");
		});
	});

	describe("restoreOverlay()", () => {
		test("returns the stored path when overlay exists", async () => {
			const srcPath = join(overlaySourceDir, "overlay.tar.gz");
			writeFileSync(srcPath, "fake-overlay-data");
			await store.saveOverlay(tenantId, workloadId, srcPath);

			const result = await store.restoreOverlay(tenantId, workloadId);

			const expectedPath = join(storagePath, tenantId, workloadId, "overlay.tar.gz");
			expect(result).toBe(expectedPath);
		});

		test("returns null when no overlay exists", async () => {
			const result = await store.restoreOverlay(tenantId, workloadId);
			expect(result).toBeNull();
		});
	});

	describe("hasOverlay()", () => {
		test("returns true when overlay exists", async () => {
			const srcPath = join(overlaySourceDir, "overlay.tar.gz");
			writeFileSync(srcPath, "fake-overlay-data");
			await store.saveOverlay(tenantId, workloadId, srcPath);

			expect(await store.hasOverlay(tenantId, workloadId)).toBe(true);
		});

		test("returns false when no overlay exists", async () => {
			expect(await store.hasOverlay(tenantId, workloadId)).toBe(false);
		});
	});

	describe("injectOverlay()", () => {
		test("calls runtime.exec with tar -xz when overlay exists", async () => {
			const srcPath = join(overlaySourceDir, "overlay.tar.gz");
			writeFileSync(srcPath, "fake-overlay-data");
			await store.saveOverlay(tenantId, workloadId, srcPath);

			// Create a fake running instance
			const instanceId = generateInstanceId();
			db.insert(instances).values({
				instanceId,
				workloadId,
				nodeId,
				status: "starting",
				createdAt: new Date(),
			}).run();
			const handle = await runtime.create(
				{ workload: { name: "t", version: "1" }, image: { ref: "t:l" }, resources: { vcpus: 1, memory_mb: 256, disk_gb: 2 }, network: { access: "none" }, idle: { action: "destroy" } },
				instanceId,
			);
			await runtime.start(handle);

			await store.injectOverlay(handle, tenantId, workloadId);

			expect(runtime.lastExecOptions).toBeDefined();
			expect(runtime.lastExecOptions!.stdin).toBeDefined();
		});

		test("no-op when no overlay exists", async () => {
			const instanceId = generateInstanceId();
			db.insert(instances).values({
				instanceId,
				workloadId,
				nodeId,
				status: "starting",
				createdAt: new Date(),
			}).run();
			const handle = await runtime.create(
				{ workload: { name: "t", version: "1" }, image: { ref: "t:l" }, resources: { vcpus: 1, memory_mb: 256, disk_gb: 2 }, network: { access: "none" }, idle: { action: "destroy" } },
				instanceId,
			);
			await runtime.start(handle);

			// No overlay stored — should be a no-op (exec not called)
			runtime.lastExecOptions = undefined;
			await store.injectOverlay(handle, tenantId, workloadId);
			expect(runtime.lastExecOptions).toBeUndefined();
		});
	});

	describe("extractOverlay()", () => {
		test("calls runtime.exec with tar -cz and saves result buffer", async () => {
			// Seed workload with overlay_dirs
			db.update(workloads).set({
				config: {
					workload: { name: "test", version: "1.0.0" },
					image: { ref: "test:latest" },
					resources: { vcpus: 1, memory_mb: 256, disk_gb: 2 },
					network: { access: "none" },
					idle: { action: "hibernate" },
					filesystem: { overlay_dirs: ["/app/data"] },
				},
			}).run();

			runtime.setExecResult({ exitCode: 0, stdout: "fake-tar-content", stderr: "" });

			const instanceId = generateInstanceId();
			db.insert(instances).values({
				instanceId,
				workloadId,
				nodeId,
				status: "starting",
				createdAt: new Date(),
			}).run();
			const handle = await runtime.create(
				{ workload: { name: "t", version: "1" }, image: { ref: "t:l" }, resources: { vcpus: 1, memory_mb: 256, disk_gb: 2 }, network: { access: "none" }, idle: { action: "destroy" } },
				instanceId,
			);
			await runtime.start(handle);

			await store.extractOverlay(handle, tenantId, workloadId);

			// Verify overlay was saved
			const row = db.select().from(tenants).where(eq(tenants.tenantId, tenantId)).get();
			expect(row!.dataOverlayRef).toBeDefined();
		});

		test("no-op when workload has no overlay_dirs", async () => {
			const instanceId = generateInstanceId();
			db.insert(instances).values({
				instanceId,
				workloadId,
				nodeId,
				status: "starting",
				createdAt: new Date(),
			}).run();
			const handle = await runtime.create(
				{ workload: { name: "t", version: "1" }, image: { ref: "t:l" }, resources: { vcpus: 1, memory_mb: 256, disk_gb: 2 }, network: { access: "none" }, idle: { action: "destroy" } },
				instanceId,
			);
			await runtime.start(handle);

			runtime.lastExecOptions = undefined;
			await store.extractOverlay(handle, tenantId, workloadId);
			// exec not called since no overlay_dirs
			expect(runtime.lastExecOptions).toBeUndefined();
		});
	});
});
