import { describe, test, expect } from "bun:test";
import { generateNodeId, generateWorkloadId } from "@boilerhouse/core";
import type { Workload } from "@boilerhouse/core";
import { nodes, workloads } from "@boilerhouse/db";
import { createTestApp, apiRequest } from "../test-helpers";

const MINIMAL_WORKLOAD: Workload = {
	workload: { name: "node-test", version: "1.0.0" },
	image: { ref: "ghcr.io/test:latest" },
	resources: { vcpus: 1, memory_mb: 512, disk_gb: 2 },
	network: { access: "none" },
	idle: { action: "hibernate" },
};

describe("GET /api/v1/nodes", () => {
	test("returns list of nodes", async () => {
		const ctx = createTestApp();
		const res = await apiRequest(ctx.app, "/api/v1/nodes");

		expect(res.status).toBe(200);
		const body = await res.json();
		// Test helper inserts one node
		expect(body).toHaveLength(1);
		expect(body[0].nodeId).toBe(ctx.nodeId);
		expect(body[0].capacity).toEqual({ vcpus: 8, memoryMb: 16384, diskGb: 100 });
		expect(body[0].status).toBe("online");
	});

	test("returns multiple nodes", async () => {
		const ctx = createTestApp();

		const secondNodeId = generateNodeId();
		ctx.db
			.insert(nodes)
			.values({
				nodeId: secondNodeId,
				runtimeType: "podman",
				capacity: { vcpus: 4, memoryMb: 8192, diskGb: 50 },
				status: "online",
				lastHeartbeat: new Date(),
				createdAt: new Date(),
			})
			.run();

		const res = await apiRequest(ctx.app, "/api/v1/nodes");
		const body = await res.json();

		expect(body).toHaveLength(2);
	});
});

describe("GET /api/v1/nodes/:id", () => {
	test("returns node details with instance count", async () => {
		const ctx = createTestApp();

		// Create instances on this node
		const workloadId = generateWorkloadId();
		ctx.db
			.insert(workloads)
			.values({
				workloadId,
				name: "node-test",
				version: "1.0.0",
				config: MINIMAL_WORKLOAD,
				createdAt: new Date(),
				updatedAt: new Date(),
			})
			.run();

		await ctx.instanceManager.create(workloadId, MINIMAL_WORKLOAD);
		await ctx.instanceManager.create(workloadId, MINIMAL_WORKLOAD);

		const res = await apiRequest(
			ctx.app,
			`/api/v1/nodes/${ctx.nodeId}`,
		);
		const body = await res.json();

		expect(res.status).toBe(200);
		expect(body.nodeId).toBe(ctx.nodeId);
		expect(body.instanceCount).toBe(2);
		expect(body.capacity).toEqual({ vcpus: 8, memoryMb: 16384, diskGb: 100 });
	});

	test("returns 404 for nonexistent node", async () => {
		const ctx = createTestApp();
		const res = await apiRequest(ctx.app, "/api/v1/nodes/nonexistent");

		expect(res.status).toBe(404);
	});
});
