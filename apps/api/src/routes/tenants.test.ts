import { describe, test, expect } from "bun:test";
import { generateWorkloadId, generateTenantId } from "@boilerhouse/core";
import type { Workload } from "@boilerhouse/core";
import { workloads } from "@boilerhouse/db";
import { createTestApp, apiRequest } from "../test-helpers";
import type { DomainEvent } from "../event-bus";

// Fixed UUIDs for deterministic multi-tenant tests
const ZAC_ID = "00000000-0000-4000-8000-00000000000a" as any;
const ZAC2_ID = "00000000-0000-4000-8000-00000000000b" as any;
const NONEXISTENT_ID = "00000000-0000-4000-8000-ffffffffffff";

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
			status: "ready",
			createdAt: new Date(),
			updatedAt: new Date(),
		})
		.run();
	return workloadId;
}

describe("POST /api/v1/tenants/:id/claim", () => {
	test("claims a tenant via cold boot", async () => {
		const ctx = createTestApp();
		const workloadId = seedWorkload(ctx);
		const tenantId = generateTenantId();

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
		expect(body.source).toBe("cold");
		expect(body.latencyMs).toBeGreaterThanOrEqual(0);
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

	test("returns 422 when workload field is missing", async () => {
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

		expect(res.status).toBe(422);
	});

	test("full multi-tenant lifecycle: claim, release, re-claim, new tenant", async () => {
		const ctx = createTestApp();
		const workloadId = seedWorkload(ctx);

		// Tenant 'zac' claims → cold boot
		const claim1 = await apiRequest(
			ctx.app,
			`/api/v1/tenants/${ZAC_ID}/claim`,
			{
				method: "POST",
				body: JSON.stringify({ workload: "tenant-test" }),
				headers: { "content-type": "application/json" },
			},
		);
		expect(claim1.status).toBe(200);
		const body1 = await claim1.json();
		expect(body1.source).toBe("cold");
		const zacInstanceId1 = body1.instanceId;

		// Tenant 'zac' releases → hibernates
		const release1 = await apiRequest(
			ctx.app,
			`/api/v1/tenants/${ZAC_ID}/release`,
			{
				method: "POST",
				body: JSON.stringify({ workload: "tenant-test" }),
				headers: { "content-type": "application/json" },
			},
		);
		expect(release1.status).toBe(200);

		// New tenant 'zac2' claims → cold boot (independent)
		const claim3 = await apiRequest(
			ctx.app,
			`/api/v1/tenants/${ZAC2_ID}/claim`,
			{
				method: "POST",
				body: JSON.stringify({ workload: "tenant-test" }),
				headers: { "content-type": "application/json" },
			},
		);
		expect(claim3.status).toBe(200);
		const body3 = await claim3.json();
		expect(body3.source).toBe("cold");
		expect(body3.instanceId).not.toBe(zacInstanceId1);

		// Verify both tenants have distinct active instances
		const instancesRes = await apiRequest(ctx.app, "/api/v1/instances?status=active");
		const activeInstances = await instancesRes.json();
		const zac2Inst = activeInstances.find((i: { tenantId: string }) => i.tenantId === ZAC2_ID);
		expect(zac2Inst).toBeDefined();
	});

	test("re-claims after instance is destroyed directly", async () => {
		const ctx = createTestApp();
		const workloadId = seedWorkload(ctx);
		const tenantId = generateTenantId();

		// First claim
		const claim1 = await apiRequest(
			ctx.app,
			`/api/v1/tenants/${tenantId}/claim`,
			{
				method: "POST",
				body: JSON.stringify({ workload: "tenant-test" }),
				headers: { "content-type": "application/json" },
			},
		);
		expect(claim1.status).toBe(200);
		const { instanceId } = await claim1.json();

		// Destroy the instance directly
		const destroyRes = await apiRequest(
			ctx.app,
			`/api/v1/instances/${instanceId}/destroy`,
			{ method: "POST" },
		);
		expect(destroyRes.status).toBe(200);

		// Re-claim should succeed via cold boot
		const claim2 = await apiRequest(
			ctx.app,
			`/api/v1/tenants/${tenantId}/claim`,
			{
				method: "POST",
				body: JSON.stringify({ workload: "tenant-test" }),
				headers: { "content-type": "application/json" },
			},
		);
		expect(claim2.status).toBe(200);
		const body2 = await claim2.json();
		expect(body2.source).toBe("cold");
	});
});

describe("POST /api/v1/tenants/:id/release", () => {
	test("releases a claimed tenant", async () => {
		const ctx = createTestApp();
		const workloadId = seedWorkload(ctx);
		const tenantId = generateTenantId();

		await ctx.tenantManager.claim(tenantId, workloadId);

		const events: DomainEvent[] = [];
		ctx.eventBus.on((e) => events.push(e));

		const res = await apiRequest(
			ctx.app,
			`/api/v1/tenants/${tenantId}/release`,
			{
				method: "POST",
				body: JSON.stringify({ workload: "tenant-test" }),
				headers: { "content-type": "application/json" },
			},
		);

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.released).toBe(true);

		expect(events).toHaveLength(2);
		expect(events[0]!.type).toBe("instance.state");
		expect((events[0] as any).status).toBe("destroyed");
		expect(events[1]!.type).toBe("tenant.released");
	});

	test("returns 404 for nonexistent tenant", async () => {
		const ctx = createTestApp();
		seedWorkload(ctx);

		const res = await apiRequest(
			ctx.app,
			`/api/v1/tenants/${NONEXISTENT_ID}/release`,
			{
				method: "POST",
				body: JSON.stringify({ workload: "tenant-test" }),
				headers: { "content-type": "application/json" },
			},
		);

		expect(res.status).toBe(404);
	});
});

describe("GET /api/v1/tenants/:id", () => {
	test("returns tenant details with instance", async () => {
		const ctx = createTestApp();
		const workloadId = seedWorkload(ctx);
		const tenantId = generateTenantId();

		const claim = await ctx.tenantManager.claim(tenantId, workloadId);

		const res = await apiRequest(
			ctx.app,
			`/api/v1/tenants/${tenantId}`,
		);

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toHaveLength(1);
		expect(body[0].tenantId).toBe(tenantId);
		expect(body[0].workloadId).toBe(workloadId);
		expect(body[0].instanceId).toBe(claim.instanceId);
		expect(body[0].instance).toBeDefined();
		expect(body[0].instance.status).toBe("active");
	});

	test("returns 404 for nonexistent tenant", async () => {
		const ctx = createTestApp();
		const res = await apiRequest(ctx.app, `/api/v1/tenants/${NONEXISTENT_ID}`);

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

		const t1 = generateTenantId();
		const t2 = generateTenantId();
		await ctx.tenantManager.claim(t1, workloadId);
		await ctx.tenantManager.claim(t2, workloadId);

		const res = await apiRequest(ctx.app, "/api/v1/tenants");
		const body = await res.json();

		expect(body).toHaveLength(2);
	});
});
