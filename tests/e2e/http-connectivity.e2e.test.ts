import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { generateTenantId } from "@boilerhouse/core";
import { availableRuntimes, E2E_TIMEOUTS } from "./runtime-matrix";
import { startE2EServer, api, readFixture, waitForWorkloadReady, type E2EServer } from "./e2e-helpers";

for (const rt of availableRuntimes()) {
	const timeouts = E2E_TIMEOUTS[rt.name as keyof typeof E2E_TIMEOUTS] ?? E2E_TIMEOUTS.fake;

	describe(`[${rt.name}] http connectivity`, () => {
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

		test("claim tenant and verify HTTP response body", async () => {
			const tenantId = generateTenantId();

			// Claim tenant
			const claimRes = await api(server, "POST", `/api/v1/tenants/${tenantId}/claim`, {
				workload: workloadName,
			});
			expect(claimRes.status).toBe(200);
			const claimBody = await claimRes.json();
			const instanceId = claimBody.instanceId as string;

			// Get endpoint details
			const endpointRes = await api(server, "GET", `/api/v1/instances/${instanceId}/endpoint`);
			expect(endpointRes.status).toBe(200);
			const endpointBody = await endpointRes.json();
			expect(endpointBody.endpoint).toBeDefined();
			expect(endpointBody.endpoint.host).toBeDefined();

			if (rt.capabilities.networking) {
				// Real runtime: fetch the actual endpoint and verify response body
				const { host, ports } = endpointBody.endpoint;
				expect(ports.length).toBeGreaterThan(0);

				const resp = await fetch(`http://${host}:${ports[0]}/`);
				expect(resp.status).toBe(200);

				const body = await resp.text();
				expect(body.length).toBeGreaterThan(0);

				const contentType = resp.headers.get("content-type") ?? "";
				expect(contentType).toContain("text/html");
			} else {
				// Fake runtime: verify endpoint metadata shape only
				expect(endpointBody.endpoint.host).toBeDefined();
				expect(endpointBody.endpoint.ports).toBeDefined();
				expect(endpointBody.endpoint.ports.length).toBeGreaterThan(0);
			}

			// Release tenant
			const releaseRes = await api(server, "POST", `/api/v1/tenants/${tenantId}/release`, { workload: workloadName });
			expect(releaseRes.status).toBe(200);
		}, timeouts.operation);
	});
}
