import { describe, test, expect } from "bun:test";
import { generateWorkloadId } from "@boilerhouse/core";
import type { Workload } from "@boilerhouse/core";
import { workloads } from "@boilerhouse/db";
import { createTestApp, apiRequest } from "../test-helpers";

const MINIMAL_WORKLOAD: Workload = {
	workload: { name: "test", version: "1.0.0" },
	image: { ref: "ghcr.io/test:latest" },
	resources: { vcpus: 1, memory_mb: 512, disk_gb: 2 },
	network: { access: "none" },
	idle: { action: "hibernate" },
};

describe("GET /api/v1/health", () => {
	test("returns 200 with status ok", async () => {
		const { app } = createTestApp();
		const res = await apiRequest(app, "/api/v1/health");

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ status: "ok" });
	});
});

describe("GET /api/v1/stats", () => {
	test("returns counts with empty database", async () => {
		const { app } = createTestApp();
		const res = await apiRequest(app, "/api/v1/stats");

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.instances).toEqual({});
		expect(body.snapshots).toBe(0);
		expect(body.nodes).toBe(1); // test helper inserts one node
	});

	test("returns instance counts by status", async () => {
		const { app, db, instanceManager } = createTestApp();

		// Insert a workload for FK
		const workloadId = generateWorkloadId();
		db.insert(workloads)
			.values({
				workloadId,
				name: "stats-test",
				version: "1.0.0",
				config: MINIMAL_WORKLOAD,
				createdAt: new Date(),
				updatedAt: new Date(),
			})
			.run();

		// Create two instances (both become active)
		await instanceManager.create(workloadId, MINIMAL_WORKLOAD);
		await instanceManager.create(workloadId, MINIMAL_WORKLOAD);

		const res = await apiRequest(app, "/api/v1/stats");
		const body = await res.json();

		expect(body.instances.active).toBe(2);
		expect(body.nodes).toBe(1);
	});
});
