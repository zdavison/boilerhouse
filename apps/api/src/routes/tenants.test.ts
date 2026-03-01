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

		expect(events).toHaveLength(2);
		expect(events[0]!.type).toBe("tenant.claiming");
		expect(events[1]!.type).toBe("tenant.claimed");
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

	test("full multi-tenant lifecycle: claim, release, re-claim, new tenant from golden", async () => {
		const ctx = createTestApp();
		const workloadId = seedWorkload(ctx);

		// 1-2. Golden snapshot created
		await ctx.snapshotManager.createGolden(workloadId, MINIMAL_WORKLOAD);

		// 3-4. Tenant 'zac' claims → restored from golden
		const claim1 = await apiRequest(
			ctx.app,
			"/api/v1/tenants/zac/claim",
			{
				method: "POST",
				body: JSON.stringify({ workload: "tenant-test" }),
				headers: { "content-type": "application/json" },
			},
		);
		expect(claim1.status).toBe(200);
		const body1 = await claim1.json();
		expect(body1.source).toBe("golden");
		const zacInstanceId1 = body1.instanceId;

		// 5-6. Tenant 'zac' releases → creates tenant snapshot
		const release1 = await apiRequest(
			ctx.app,
			"/api/v1/tenants/zac/release",
			{ method: "POST" },
		);
		expect(release1.status).toBe(200);

		// Verify a tenant snapshot was created for zac
		const snapshotsRes1 = await apiRequest(ctx.app, "/api/v1/snapshots");
		const allSnapshots1 = await snapshotsRes1.json();
		const zacSnap = allSnapshots1.find(
			(s: { type: string; tenantId: string }) => s.type === "tenant" && s.tenantId === "zac",
		);
		expect(zacSnap).toBeDefined();

		// 7-8. Tenant 'zac' re-claims → restored from tenant snapshot
		const claim2 = await apiRequest(
			ctx.app,
			"/api/v1/tenants/zac/claim",
			{
				method: "POST",
				body: JSON.stringify({ workload: "tenant-test" }),
				headers: { "content-type": "application/json" },
			},
		);
		expect(claim2.status).toBe(200);
		const body2 = await claim2.json();
		expect(body2.source).toBe("snapshot");
		expect(body2.instanceId).not.toBe(zacInstanceId1);

		// 9-10. New tenant 'zac2' claims → restored from golden (not tenant:zac)
		const claim3 = await apiRequest(
			ctx.app,
			"/api/v1/tenants/zac2/claim",
			{
				method: "POST",
				body: JSON.stringify({ workload: "tenant-test" }),
				headers: { "content-type": "application/json" },
			},
		);
		expect(claim3.status).toBe(200);
		const body3 = await claim3.json();
		expect(body3.source).toBe("golden");
		expect(body3.instanceId).not.toBe(body2.instanceId);

		// Verify instance parentage via API: zac2's instance has no tenant snapshot
		const snapshotsRes2 = await apiRequest(ctx.app, "/api/v1/snapshots");
		const allSnapshots2 = await snapshotsRes2.json();
		const zac2Snap = allSnapshots2.find(
			(s: { type: string; tenantId: string }) => s.type === "tenant" && s.tenantId === "zac2",
		);
		expect(zac2Snap).toBeUndefined();

		// Verify both instances are active with correct tenantIds
		const instancesRes = await apiRequest(ctx.app, "/api/v1/instances?status=active");
		const activeInstances = await instancesRes.json();
		const zacInst = activeInstances.find((i: { tenantId: string }) => i.tenantId === "zac");
		const zac2Inst = activeInstances.find((i: { tenantId: string }) => i.tenantId === "zac2");
		expect(zacInst).toBeDefined();
		expect(zac2Inst).toBeDefined();
	});

	test("re-claims after instance is hibernated directly", async () => {
		const ctx = createTestApp();
		const workloadId = seedWorkload(ctx);
		const tenantId = generateTenantId();

		await ctx.snapshotManager.createGolden(workloadId, MINIMAL_WORKLOAD);

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

		// Hibernate via instance endpoint (not tenant release)
		const hibRes = await apiRequest(
			ctx.app,
			`/api/v1/instances/${instanceId}/hibernate`,
			{ method: "POST" },
		);
		expect(hibRes.status).toBe(200);

		// Re-claim same tenant
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
		expect(body2.tenantId).toBe(tenantId);
		expect(body2.source).toBe("snapshot");
	});

	test("re-claims after instance is destroyed directly", async () => {
		const ctx = createTestApp();
		const workloadId = seedWorkload(ctx);

		await ctx.snapshotManager.createGolden(workloadId, MINIMAL_WORKLOAD);

		// Claim → hibernate (establish a tenant snapshot)
		const claim1 = await apiRequest(
			ctx.app,
			"/api/v1/tenants/zac/claim",
			{
				method: "POST",
				body: JSON.stringify({ workload: "tenant-test" }),
				headers: { "content-type": "application/json" },
			},
		);
		expect(claim1.status).toBe(200);
		const { instanceId: inst1 } = await claim1.json();

		await apiRequest(ctx.app, `/api/v1/instances/${inst1}/hibernate`, { method: "POST" });

		// Re-claim, then destroy
		const claim2 = await apiRequest(
			ctx.app,
			"/api/v1/tenants/zac/claim",
			{
				method: "POST",
				body: JSON.stringify({ workload: "tenant-test" }),
				headers: { "content-type": "application/json" },
			},
		);
		const { instanceId: inst2 } = await claim2.json();

		const destroyRes = await apiRequest(
			ctx.app,
			`/api/v1/instances/${inst2}/destroy`,
			{ method: "POST" },
		);
		expect(destroyRes.status).toBe(200);

		// Re-claim should succeed
		const claim3 = await apiRequest(
			ctx.app,
			"/api/v1/tenants/zac/claim",
			{
				method: "POST",
				body: JSON.stringify({ workload: "tenant-test" }),
				headers: { "content-type": "application/json" },
			},
		);
		expect(claim3.status).toBe(200);
		const body3 = await claim3.json();
		expect(body3.source).toBe("snapshot");
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

		expect(events).toHaveLength(2);
		expect(events[0]!.type).toBe("instance.state");
		expect(events[1]!.type).toBe("tenant.released");
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
