import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import {
	type WorkloadId,
	type NodeId,
	type TenantId,
	generateWorkloadId,
	generateNodeId,
	generateTenantId,
} from "@boilerhouse/core";
import {
	createTestDatabase,
	type DrizzleDb,
	tenants,
	nodes,
	workloads,
} from "@boilerhouse/db";
import { TenantDataStore } from "./tenant-data";

let db: DrizzleDb;
let storagePath: string;
let store: TenantDataStore;
let nodeId: NodeId;
let workloadId: WorkloadId;
let tenantId: TenantId;
let overlaySourceDir: string;

beforeEach(() => {
	db = createTestDatabase();
	storagePath = mkdtempSync(join(tmpdir(), "tenant-data-test-"));
	overlaySourceDir = mkdtempSync(join(tmpdir(), "tenant-overlay-src-"));
	store = new TenantDataStore(storagePath, db);

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
		test("copies overlay file to {storagePath}/{tenantId}/{workloadId}/overlay.ext4", () => {
			const srcPath = join(overlaySourceDir, "overlay.ext4");
			writeFileSync(srcPath, "fake-overlay-data");

			store.saveOverlay(tenantId, workloadId, srcPath);

			const destPath = join(storagePath, tenantId, workloadId, "overlay.ext4");
			expect(existsSync(destPath)).toBe(true);
			expect(readFileSync(destPath, "utf-8")).toBe("fake-overlay-data");
		});

		test("records dataOverlayRef on tenant row", () => {
			const srcPath = join(overlaySourceDir, "overlay.ext4");
			writeFileSync(srcPath, "fake-overlay-data");

			store.saveOverlay(tenantId, workloadId, srcPath);

			const row = db
				.select()
				.from(tenants)
				.where(eq(tenants.tenantId, tenantId))
				.get();

			const expectedPath = join(storagePath, tenantId, workloadId, "overlay.ext4");
			expect(row!.dataOverlayRef).toBe(expectedPath);
		});

		test("overwrites previous overlay for same tenant+workload", () => {
			const srcPath1 = join(overlaySourceDir, "overlay1.ext4");
			writeFileSync(srcPath1, "first-version");
			store.saveOverlay(tenantId, workloadId, srcPath1);

			const srcPath2 = join(overlaySourceDir, "overlay2.ext4");
			writeFileSync(srcPath2, "second-version");
			store.saveOverlay(tenantId, workloadId, srcPath2);

			const destPath = join(storagePath, tenantId, workloadId, "overlay.ext4");
			expect(readFileSync(destPath, "utf-8")).toBe("second-version");
		});
	});

	describe("restoreOverlay()", () => {
		test("returns the stored path when overlay exists", () => {
			const srcPath = join(overlaySourceDir, "overlay.ext4");
			writeFileSync(srcPath, "fake-overlay-data");
			store.saveOverlay(tenantId, workloadId, srcPath);

			const result = store.restoreOverlay(tenantId);

			const expectedPath = join(storagePath, tenantId, workloadId, "overlay.ext4");
			expect(result).toBe(expectedPath);
		});

		test("returns null when no overlay exists", () => {
			const result = store.restoreOverlay(tenantId);
			expect(result).toBeNull();
		});
	});
});
