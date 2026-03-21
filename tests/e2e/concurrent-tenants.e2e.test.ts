import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { generateTenantId } from "@boilerhouse/core";
import { availableRuntimes, E2E_TIMEOUTS } from "./runtime-matrix";
import { startE2EServer, api, readFixture, waitForWorkloadReady, type E2EServer } from "./e2e-helpers";

for (const rt of availableRuntimes()) {
	const timeouts = E2E_TIMEOUTS[rt.name as keyof typeof E2E_TIMEOUTS] ?? E2E_TIMEOUTS.fake;

	describe(`[${rt.name}] concurrent tenants`, () => {
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

		test("3 tenants claim and release in parallel", async () => {
			// Step 2: Claim 3 tenants in parallel
			const tenantIds = [generateTenantId(), generateTenantId(), generateTenantId()];
			const claimResults = await Promise.all(
				tenantIds.map((id) =>
					api(server, "POST", `/api/v1/tenants/${id}/claim`, {
						workload: workloadName,
					}).then(async (res) => ({
						status: res.status,
						body: await res.json(),
					})),
				),
			);

			for (const result of claimResults) {
				expect(result.status).toBe(200);
				expect(result.body.instanceId).toBeDefined();
			}

			// Verify all instanceIds are distinct
			const instanceIds = claimResults.map((r) => r.body.instanceId);
			const uniqueIds = new Set(instanceIds);
			expect(uniqueIds.size).toBe(3);

			// Step 3: Verify 3 active instances
			const activeRes = await api(server, "GET", "/api/v1/instances?status=active");
			expect(activeRes.status).toBe(200);
			const activeInstances = await activeRes.json();
			expect(activeInstances.length).toBe(3);

			// Step 4: Verify distinct endpoints (skip if no ports exposed)
			const endpoints = claimResults.map((r) => r.body.endpoint);
			if (endpoints[0]?.ports?.length > 0) {
				const endpointKeys = endpoints.map(
					(e: { host: string; ports: number[] }) => `${e.host}:${e.ports.join(",")}`,
				);
				const uniqueEndpoints = new Set(endpointKeys);
				expect(uniqueEndpoints.size).toBe(3);
			}

			// Step 5: Release all 3 in parallel
			const releaseResults = await Promise.all(
				tenantIds.map((id) =>
					api(server, "POST", `/api/v1/tenants/${id}/release`).then(
						async (res) => ({
							status: res.status,
							body: await res.json(),
						}),
					),
				),
			);

			for (const result of releaseResults) {
				expect(result.status).toBe(200);
			}

			// Step 6: No active instances remaining
			const activeRes2 = await api(server, "GET", "/api/v1/instances?status=active");
			expect(activeRes2.status).toBe(200);
			const activeInstances2 = await activeRes2.json();
			expect(activeInstances2.length).toBe(0);

			// Step 7: Verify cleanup
			await rt.verifyCleanup();
		}, timeouts.operation);
	});
}
