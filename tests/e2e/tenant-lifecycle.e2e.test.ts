import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { generateTenantId } from "@boilerhouse/core";
import { activityLog } from "@boilerhouse/db";
import { availableRuntimes, E2E_TIMEOUTS } from "./runtime-matrix";
import { startE2EServer, api, readFixture, waitForWorkloadReady, type E2EServer } from "./e2e-helpers";

for (const rt of availableRuntimes()) {
	const timeouts = E2E_TIMEOUTS[rt.name as keyof typeof E2E_TIMEOUTS] ?? E2E_TIMEOUTS.fake;

	describe(`[${rt.name}] tenant lifecycle`, () => {
		let server: E2EServer;
		let workloadName: string;

		beforeAll(async () => {
			server = await startE2EServer(rt.name);
			const fixture = await readFixture(rt.workloadFixtures.httpserver);

			const registerRes = await api(server, "POST", "/api/v1/workloads", fixture);
			expect(registerRes.status).toBe(201);
			const registerBody = await registerRes.json();
			workloadName = registerBody.name;

			await waitForWorkloadReady(server, workloadName);
		}, timeouts.operation);

		afterAll(async () => {
			if (server) await server.cleanup();
		});

		test("full claim/release cycle with re-claim", async () => {
			const tenantId = generateTenantId();

			// Step 2: Verify golden snapshot exists (only for golden-snapshot-capable runtimes)
			if (rt.capabilities.goldenSnapshot) {
				const snapshotsRes = await api(server, "GET", `/api/v1/workloads/${workloadName}/snapshots`);
				expect(snapshotsRes.status).toBe(200);
				const snapshotsList = await snapshotsRes.json();
				expect(snapshotsList.length).toBeGreaterThanOrEqual(1);
				const goldenSnapshot = snapshotsList.find((s: { type: string }) => s.type === "golden");
				expect(goldenSnapshot).toBeDefined();
			}

			// Step 3: First claim
			const claim1Res = await api(server, "POST", `/api/v1/tenants/${tenantId}/claim`, {
				workload: workloadName,
			});
			expect(claim1Res.status).toBe(200);
			const claim1Body = await claim1Res.json();
			expect(["golden", "cold", "pool"]).toContain(claim1Body.source);
			expect(claim1Body.endpoint).toBeDefined();
			const firstInstanceId = claim1Body.instanceId as string;

			// Step 4: Verify tenant details
			const tenantRes = await api(server, "GET", `/api/v1/tenants/${tenantId}`);
			expect(tenantRes.status).toBe(200);
			const tenantBody = await tenantRes.json();
			expect(tenantBody).toHaveLength(1);
			expect(tenantBody[0].instanceId).toBe(firstInstanceId);
			expect(tenantBody[0].instance).toBeDefined();
			expect(tenantBody[0].instance.status).toBe("active");

			// Step 5: Verify instance reachable (only for real runtimes with ports)
			if (rt.capabilities.networking && claim1Body.endpoint?.ports?.length > 0) {
				const { host, ports } = claim1Body.endpoint;
				const resp = await fetch(`http://${host}:${ports[0]}`);
				expect(resp.ok).toBe(true);
			}

			// Step 6: Release tenant
			const release1Res = await api(server, "POST", `/api/v1/tenants/${tenantId}/release`, {
				workload: workloadName,
			});
			expect(release1Res.status).toBe(200);

			// Step 7: Verify tenant instanceId cleared
			const tenant2Res = await api(server, "GET", `/api/v1/tenants/${tenantId}`);
			expect(tenant2Res.status).toBe(200);
			const tenant2Body = await tenant2Res.json();
			expect(tenant2Body[0].instanceId).toBeNull();

			// Step 8: Verify first instance is no longer active
			const instance1Res = await api(server, "GET", `/api/v1/instances/${firstInstanceId}`);
			expect(instance1Res.status).toBe(200);
			const instance1Body = await instance1Res.json();
			expect(["destroyed", "hibernated"]).toContain(instance1Body.status);

			// Step 9: Second claim — cold/pool boot (httpserver has no overlay dirs)
			const claim2Res = await api(server, "POST", `/api/v1/tenants/${tenantId}/claim`, {
				workload: workloadName,
			});
			expect(claim2Res.status).toBe(200);
			const claim2Body = await claim2Res.json();
			expect(["golden", "cold", "pool", "cold+data", "pool+data"]).toContain(claim2Body.source);
			expect(claim2Body.instanceId).not.toBe(firstInstanceId);

			// Step 11: Release second claim
			const release2Res = await api(server, "POST", `/api/v1/tenants/${tenantId}/release`, {
				workload: workloadName,
			});
			expect(release2Res.status).toBe(200);

			// Step 12: Verify activity log trail
			const logs = server.db
				.select()
				.from(activityLog)
				.where(eq(activityLog.tenantId, tenantId))
				.all();
			const events = logs.map((l) => l.event);
			expect(events).toContain("tenant.claimed");
			expect(events).toContain("tenant.released");
		}, timeouts.operation);
	});
}
