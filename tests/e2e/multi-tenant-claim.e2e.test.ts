import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { generateTenantId } from "@boilerhouse/core";
import { availableRuntimes, E2E_TIMEOUTS } from "./runtime-matrix";
import { startE2EServer, api, readFixture, waitForWorkloadReady, type E2EServer } from "./e2e-helpers";

for (const rt of availableRuntimes()) {
	const timeouts = E2E_TIMEOUTS[rt.name as keyof typeof E2E_TIMEOUTS] ?? E2E_TIMEOUTS.fake;

	describe(`[${rt.name}] multi-tenant claim`, () => {
		let server: E2EServer;
		let workloadName: string;

		beforeAll(async () => {
			server = await startE2EServer(rt.name);
			const fixture = await readFixture(rt.workloadFixtures.httpserver);

			const registerRes = await api(server, "POST", "/api/v1/workloads", fixture);
			expect(registerRes.status).toBe(201);
			const body = await registerRes.json();
			workloadName = body.name;

			await waitForWorkloadReady(server, workloadName);
		}, timeouts.operation);

		afterAll(async () => {
			if (server) await server.cleanup();
		});

		test("two different tenants can claim the same workload sequentially", async () => {
			const tenantId1 = generateTenantId();
			const tenantId2 = generateTenantId();

			// Tenant 1 claims
			const claim1Res = await api(server, "POST", `/api/v1/tenants/${tenantId1}/claim`, {
				workload: workloadName,
			});
			expect(claim1Res.status).toBe(200);
			const claim1Body = await claim1Res.json();
			expect(["golden", "cold", "pool"]).toContain(claim1Body.source);
			expect(claim1Body.instanceId).toBeDefined();

			// Tenant 2 claims the same workload
			const claim2Res = await api(server, "POST", `/api/v1/tenants/${tenantId2}/claim`, {
				workload: workloadName,
			});
			expect(claim2Res.status).toBe(200);
			const claim2Body = await claim2Res.json();
			expect(["golden", "cold", "pool"]).toContain(claim2Body.source);
			expect(claim2Body.instanceId).toBeDefined();

			// Instance IDs must be distinct
			expect(claim2Body.instanceId).not.toBe(claim1Body.instanceId);

			// Both tenants should have active instances
			const tenant1Res = await api(server, "GET", `/api/v1/tenants/${tenantId1}`);
			expect(tenant1Res.status).toBe(200);
			const tenant1 = await tenant1Res.json();
			expect(tenant1[0].instanceId).toBe(claim1Body.instanceId);

			const tenant2Res = await api(server, "GET", `/api/v1/tenants/${tenantId2}`);
			expect(tenant2Res.status).toBe(200);
			const tenant2 = await tenant2Res.json();
			expect(tenant2[0].instanceId).toBe(claim2Body.instanceId);

			// Verify at least 2 active instances exist (pool may pre-warm extras)
			const activeRes = await api(server, "GET", "/api/v1/instances?status=active");
			expect(activeRes.status).toBe(200);
			const activeInstances = await activeRes.json();
			expect(activeInstances.length).toBeGreaterThanOrEqual(2);

			// Release both
			const release1 = await api(server, "POST", `/api/v1/tenants/${tenantId1}/release`, { workload: workloadName });
			expect(release1.status).toBe(200);

			const release2 = await api(server, "POST", `/api/v1/tenants/${tenantId2}/release`, { workload: workloadName });
			expect(release2.status).toBe(200);
		}, timeouts.operation);
	});
}
