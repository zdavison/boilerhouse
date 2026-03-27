import { describe, test, expect } from "bun:test";
import { generateWorkloadId } from "@boilerhouse/core";
import type { Workload } from "@boilerhouse/core";
import { workloads } from "@boilerhouse/db";
import { createTestApp, apiRequest } from "../test-helpers";
import type { DomainEvent } from "../event-bus";

const MINIMAL_WORKLOAD: Workload = {
	workload: { name: "test", version: "1.0.0" },
	image: { ref: "ghcr.io/test:latest" },
	resources: { vcpus: 1, memory_mb: 512, disk_gb: 2 },
	network: { access: "none" },
	idle: { action: "hibernate" },
};

function seedWorkload(ctx: ReturnType<typeof createTestApp>) {
	const workloadId = generateWorkloadId();
	ctx.db
		.insert(workloads)
		.values({
			workloadId,
			name: "inst-test",
			version: "1.0.0",
			config: MINIMAL_WORKLOAD,
			createdAt: new Date(),
			updatedAt: new Date(),
		})
		.run();
	return workloadId;
}

describe("GET /api/v1/instances", () => {
	test("returns empty list", async () => {
		const ctx = createTestApp();
		const res = await apiRequest(ctx.app, "/api/v1/instances");

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([]);
	});

	test("returns all instances", async () => {
		const ctx = createTestApp();
		const workloadId = seedWorkload(ctx);

		await ctx.instanceManager.create(workloadId, MINIMAL_WORKLOAD);
		await ctx.instanceManager.create(workloadId, MINIMAL_WORKLOAD);

		const res = await apiRequest(ctx.app, "/api/v1/instances");
		const body = await res.json();

		expect(body).toHaveLength(2);
		expect(body[0].status).toBe("active");
	});

	test("filters by status", async () => {
		const ctx = createTestApp();
		const workloadId = seedWorkload(ctx);

		const handle1 = await ctx.instanceManager.create(workloadId, MINIMAL_WORKLOAD);
		await ctx.instanceManager.create(workloadId, MINIMAL_WORKLOAD);
		await ctx.instanceManager.destroy(handle1.instanceId);

		const res = await apiRequest(ctx.app, "/api/v1/instances?status=active");
		const body = await res.json();

		expect(body).toHaveLength(1);
		expect(body[0].status).toBe("active");
	});
});

describe("GET /api/v1/instances/:id", () => {
	test("returns instance details", async () => {
		const ctx = createTestApp();
		const workloadId = seedWorkload(ctx);

		const handle = await ctx.instanceManager.create(workloadId, MINIMAL_WORKLOAD);

		const res = await apiRequest(
			ctx.app,
			`/api/v1/instances/${handle.instanceId}`,
		);
		const body = await res.json();

		expect(res.status).toBe(200);
		expect(body.instanceId).toBe(handle.instanceId);
		expect(body.status).toBe("active");
		expect(body.workloadId).toBe(workloadId);
	});

	test("returns 404 for nonexistent instance", async () => {
		const ctx = createTestApp();
		const res = await apiRequest(
			ctx.app,
			"/api/v1/instances/nonexistent-id",
		);

		expect(res.status).toBe(404);
	});
});

describe("POST /api/v1/instances/:id/hibernate", () => {
	test("route is not mounted — returns 404", async () => {
		const ctx = createTestApp();
		const workloadId = seedWorkload(ctx);

		const handle = await ctx.instanceManager.create(workloadId, MINIMAL_WORKLOAD);

		const res = await apiRequest(
			ctx.app,
			`/api/v1/instances/${handle.instanceId}/hibernate`,
			{ method: "POST" },
		);

		expect(res.status).toBe(404);
	});
});

describe("POST /api/v1/instances/:id/exec", () => {
	test("executes a command in an active instance", async () => {
		const ctx = createTestApp();
		const workloadId = seedWorkload(ctx);

		const handle = await ctx.instanceManager.create(workloadId, MINIMAL_WORKLOAD);

		const res = await apiRequest(
			ctx.app,
			`/api/v1/instances/${handle.instanceId}/exec`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ command: ["echo", "hello"] }),
			},
		);
		const body = await res.json();

		expect(res.status).toBe(200);
		expect(body.exitCode).toBe(0);
		expect(body.stdout).toBeDefined();
		expect(body.stderr).toBeDefined();
	});

	test("returns 404 for nonexistent instance", async () => {
		const ctx = createTestApp();
		const res = await apiRequest(
			ctx.app,
			"/api/v1/instances/nonexistent/exec",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ command: ["echo"] }),
			},
		);

		expect(res.status).toBe(404);
	});

	test("returns 409 for non-active instance", async () => {
		const ctx = createTestApp();
		const workloadId = seedWorkload(ctx);

		const handle = await ctx.instanceManager.create(workloadId, MINIMAL_WORKLOAD);
		await ctx.instanceManager.destroy(handle.instanceId);

		const res = await apiRequest(
			ctx.app,
			`/api/v1/instances/${handle.instanceId}/exec`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ command: ["echo"] }),
			},
		);

		expect(res.status).toBe(409);
	});
});

describe("POST /api/v1/instances/:id/destroy", () => {
	test("destroys an active instance", async () => {
		const ctx = createTestApp();
		const workloadId = seedWorkload(ctx);

		const handle = await ctx.instanceManager.create(workloadId, MINIMAL_WORKLOAD);

		const events: DomainEvent[] = [];
		ctx.eventBus.on((e) => events.push(e));

		const res = await apiRequest(
			ctx.app,
			`/api/v1/instances/${handle.instanceId}/destroy`,
			{ method: "POST" },
		);
		const body = await res.json();

		expect(res.status).toBe(200);
		expect(body.status).toBe("destroyed");

		expect(events).toHaveLength(1);
		expect(events[0]!.type).toBe("instance.state");
	});

	test("returns 404 for nonexistent instance", async () => {
		const ctx = createTestApp();
		const res = await apiRequest(
			ctx.app,
			"/api/v1/instances/nonexistent/destroy",
			{ method: "POST" },
		);

		expect(res.status).toBe(404);
	});
});
