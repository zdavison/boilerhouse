import { describe, test, expect } from "bun:test";
import { generateWorkloadId, generateTenantId } from "@boilerhouse/core";
import type { Workload } from "@boilerhouse/core";
import { workloads } from "@boilerhouse/db";
import { createTestApp, apiRequest } from "../test-helpers";
import type { DomainEvent } from "../event-bus";

const MINIMAL_WORKLOAD: Workload = {
	workload: { name: "tenant-test", version: "1.0.0" },
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
			name: "tenant-test",
			version: "1.0.0",
			config: MINIMAL_WORKLOAD,
			createdAt: new Date(),
			updatedAt: new Date(),
		})
		.run();
	return workloadId;
}

describe("POST /api/v1/tenants/:id/claim", () => {
	test("claims a tenant with a golden snapshot", async () => {
		const ctx = createTestApp();
		const workloadId = seedWorkload(ctx);
		const tenantId = generateTenantId();

		// Create a golden snapshot first
		await ctx.snapshotManager.createGolden(workloadId, MINIMAL_WORKLOAD);

		const events: DomainEvent[] = [];
		ctx.eventBus.on((e) => events.push(e));

		const res = await apiRequest(
			ctx.app,
			`/api/v1/tenants/${tenantId}/claim`,
			{
				method: "POST",
				body: JSON.stringify({ workload: "tenant-test" }),
				headers: { "content-type": "application/json" },
			},
		);

		expect(res.status).toBe(200);
		const body = await res.json();

		expect(body.tenantId).toBe(tenantId);
		expect(body.instanceId).toBeDefined();
		expect(body.endpoint).toBeDefined();
		expect(body.source).toBe("golden");
		expect(body.latencyMs).toBeGreaterThanOrEqual(0);

		expect(events).toHaveLength(1);
		expect(events[0]!.type).toBe("tenant.claimed");
	});

	test("returns 503 when no golden snapshot exists", async () => {
		const ctx = createTestApp();
		seedWorkload(ctx);
		const tenantId = generateTenantId();

		const res = await apiRequest(
			ctx.app,
			`/api/v1/tenants/${tenantId}/claim`,
			{
				method: "POST",
				body: JSON.stringify({ workload: "tenant-test" }),
				headers: { "content-type": "application/json" },
			},
		);

		expect(res.status).toBe(503);
	});

	test("returns 404 for nonexistent workload name", async () => {
		const ctx = createTestApp();
		const tenantId = generateTenantId();

		const res = await apiRequest(
			ctx.app,
			`/api/v1/tenants/${tenantId}/claim`,
			{
				method: "POST",
				body: JSON.stringify({ workload: "nonexistent" }),
				headers: { "content-type": "application/json" },
			},
		);

		expect(res.status).toBe(404);
	});

	test("returns 400 when workload field is missing", async () => {
		const ctx = createTestApp();
		const tenantId = generateTenantId();

		const res = await apiRequest(
			ctx.app,
			`/api/v1/tenants/${tenantId}/claim`,
			{
				method: "POST",
				body: JSON.stringify({}),
				headers: { "content-type": "application/json" },
			},
		);

		expect(res.status).toBe(400);
	});
});

describe("POST /api/v1/tenants/:id/release", () => {
	test("releases a claimed tenant", async () => {
		const ctx = createTestApp();
		const workloadId = seedWorkload(ctx);
		const tenantId = generateTenantId();

		await ctx.snapshotManager.createGolden(workloadId, MINIMAL_WORKLOAD);
		await ctx.tenantManager.claim(tenantId, workloadId);

		const events: DomainEvent[] = [];
		ctx.eventBus.on((e) => events.push(e));

		const res = await apiRequest(
			ctx.app,
			`/api/v1/tenants/${tenantId}/release`,
			{ method: "POST" },
		);

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.released).toBe(true);

		expect(events).toHaveLength(1);
		expect(events[0]!.type).toBe("tenant.released");
	});

	test("returns 404 for nonexistent tenant", async () => {
		const ctx = createTestApp();

		const res = await apiRequest(
			ctx.app,
			"/api/v1/tenants/nonexistent/release",
			{ method: "POST" },
		);

		expect(res.status).toBe(404);
	});
});

describe("GET /api/v1/tenants/:id", () => {
	test("returns tenant details with instance and snapshots", async () => {
		const ctx = createTestApp();
		const workloadId = seedWorkload(ctx);
		const tenantId = generateTenantId();

		await ctx.snapshotManager.createGolden(workloadId, MINIMAL_WORKLOAD);
		const claim = await ctx.tenantManager.claim(tenantId, workloadId);

		const res = await apiRequest(
			ctx.app,
			`/api/v1/tenants/${tenantId}`,
		);

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.tenantId).toBe(tenantId);
		expect(body.workloadId).toBe(workloadId);
		expect(body.instanceId).toBe(claim.instanceId);
		expect(body.instance).toBeDefined();
		expect(body.instance.status).toBe("active");
	});

	test("returns 404 for nonexistent tenant", async () => {
		const ctx = createTestApp();
		const res = await apiRequest(ctx.app, "/api/v1/tenants/ghost");

		expect(res.status).toBe(404);
	});
});

describe("GET /api/v1/tenants", () => {
	test("returns empty list", async () => {
		const ctx = createTestApp();
		const res = await apiRequest(ctx.app, "/api/v1/tenants");

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([]);
	});

	test("returns list of tenants", async () => {
		const ctx = createTestApp();
		const workloadId = seedWorkload(ctx);

		await ctx.snapshotManager.createGolden(workloadId, MINIMAL_WORKLOAD);

		const t1 = generateTenantId();
		const t2 = generateTenantId();
		await ctx.tenantManager.claim(t1, workloadId);
		await ctx.tenantManager.claim(t2, workloadId);

		const res = await apiRequest(ctx.app, "/api/v1/tenants");
		const body = await res.json();

		expect(body).toHaveLength(2);
	});
});
