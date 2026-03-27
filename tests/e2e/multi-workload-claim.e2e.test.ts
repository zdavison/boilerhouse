import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { generateTenantId } from "@boilerhouse/core";
import { availableRuntimes, E2E_TIMEOUTS } from "./runtime-matrix";
import { startE2EServer, api, readFixture, waitForWorkloadReady, type E2EServer } from "./e2e-helpers";

for (const rt of availableRuntimes()) {
	const timeouts = E2E_TIMEOUTS[rt.name as keyof typeof E2E_TIMEOUTS] ?? E2E_TIMEOUTS.fake;

	describe(`[${rt.name}] multi-workload claim`, () => {
		let server: E2EServer;
		let workloadNameA: string;
		let workloadNameB: string;

		beforeAll(async () => {
			server = await startE2EServer(rt.name);

			// Register two different workloads
			const fixtureA = await readFixture(rt.workloadFixtures.httpserver);
			const registerA = await api(server, "POST", "/api/v1/workloads", fixtureA);
			expect(registerA.status).toBe(201);
			workloadNameA = (await registerA.json()).name;

			const fixtureB = await readFixture(rt.workloadFixtures.minimal);
			const registerB = await api(server, "POST", "/api/v1/workloads", fixtureB);
			expect(registerB.status).toBe(201);
			workloadNameB = (await registerB.json()).name;

			await waitForWorkloadReady(server, workloadNameA);
			await waitForWorkloadReady(server, workloadNameB);
		}, timeouts.operation);

		afterAll(async () => {
			if (server) await server.cleanup();
		});

		test("same tenant can claim two different workloads simultaneously", async () => {
			const tenantId = generateTenantId();

			// Claim workload A
			const claimA = await api(server, "POST", `/api/v1/tenants/${tenantId}/claim`, {
				workload: workloadNameA,
			});
			expect(claimA.status).toBe(200);
			const bodyA = await claimA.json();
			expect(bodyA.instanceId).toBeDefined();

			// Claim workload B with the SAME tenant ID
			const claimB = await api(server, "POST", `/api/v1/tenants/${tenantId}/claim`, {
				workload: workloadNameB,
			});
			expect(claimB.status).toBe(200);
			const bodyB = await claimB.json();
			expect(bodyB.instanceId).toBeDefined();

			// Must be different instances
			expect(bodyB.instanceId).not.toBe(bodyA.instanceId);

			// GET tenant returns both claims
			const tenantRes = await api(server, "GET", `/api/v1/tenants/${tenantId}`);
			expect(tenantRes.status).toBe(200);
			const tenantBody = await tenantRes.json();
			expect(tenantBody).toHaveLength(2);

			const workloadIds = tenantBody.map((t: { workloadId: string }) => t.workloadId);
			const instanceIds = tenantBody.map((t: { instanceId: string }) => t.instanceId);
			expect(new Set(workloadIds).size).toBe(2);
			expect(instanceIds).toContain(bodyA.instanceId);
			expect(instanceIds).toContain(bodyB.instanceId);

			// Re-claiming each workload returns the existing instance
			const reclaimA = await api(server, "POST", `/api/v1/tenants/${tenantId}/claim`, {
				workload: workloadNameA,
			});
			expect(reclaimA.status).toBe(200);
			const reclaimABody = await reclaimA.json();
			expect(reclaimABody.source).toBe("existing");
			expect(reclaimABody.instanceId).toBe(bodyA.instanceId);

			const reclaimB = await api(server, "POST", `/api/v1/tenants/${tenantId}/claim`, {
				workload: workloadNameB,
			});
			expect(reclaimB.status).toBe(200);
			const reclaimBBody = await reclaimB.json();
			expect(reclaimBBody.source).toBe("existing");
			expect(reclaimBBody.instanceId).toBe(bodyB.instanceId);

			// Release workload A only — workload B remains active
			const releaseA = await api(server, "POST", `/api/v1/tenants/${tenantId}/release`, {
				workload: workloadNameA,
			});
			expect(releaseA.status).toBe(200);

			// Verify workload B is still active
			const tenantAfter = await api(server, "GET", `/api/v1/tenants/${tenantId}`);
			const afterBody = await tenantAfter.json();
			const activeEntries = afterBody.filter(
				(t: { instanceId: string | null }) => t.instanceId !== null,
			);
			expect(activeEntries).toHaveLength(1);
			expect(activeEntries[0].instanceId).toBe(bodyB.instanceId);

			// Release workload B
			const releaseB = await api(server, "POST", `/api/v1/tenants/${tenantId}/release`, {
				workload: workloadNameB,
			});
			expect(releaseB.status).toBe(200);
		}, timeouts.operation);
	});
}
