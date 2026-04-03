import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { generateTenantId } from "@boilerhouse/core";
import type { InstanceId } from "@boilerhouse/core";
import { activityLog } from "@boilerhouse/db";
import { availableRuntimes, E2E_TIMEOUTS } from "./runtime-matrix";
import { startE2EServer, api, readFixture, waitForWorkloadReady, type E2EServer } from "./e2e-helpers";

for (const rt of availableRuntimes()) {
	const timeouts = E2E_TIMEOUTS[rt.name as keyof typeof E2E_TIMEOUTS] ?? E2E_TIMEOUTS.fake;

	describe(`[${rt.name}] instance lifecycle`, () => {
		let server: E2EServer;
		let workloadName: string;

		beforeAll(async () => {
			server = await startE2EServer(rt.name);
			const fixture = await readFixture(rt.workloadFixtures.httpserver);

			const registerRes = await api(server, "POST", "/api/v1/workloads", fixture);
			expect(registerRes.status).toBe(201);
			const registerBody = await registerRes.json();
			expect(registerBody.workloadId).toBeDefined();
			workloadName = registerBody.name;

			await waitForWorkloadReady(server, workloadName);
		}, timeouts.operation);

		afterAll(async () => {
			if (server) await server.cleanup();
		});

		test("full lifecycle: register, claim, verify, release, cleanup", async () => {
			const tenantId = generateTenantId();

			// Step 2: Claim tenant
			const claimRes = await api(server, "POST", `/api/v1/tenants/${tenantId}/claim`, {
				workload: workloadName,
			});
			expect(claimRes.status).toBe(200);
			const claimBody = await claimRes.json();
			expect(claimBody.instanceId).toBeDefined();
			expect(claimBody.endpoint).toBeDefined();
			expect(claimBody.source).toBeDefined();

			const instanceId = claimBody.instanceId as string;

			// Step 3: Verify instance is active
			const instanceRes = await api(server, "GET", `/api/v1/instances/${instanceId}`);
			expect(instanceRes.status).toBe(200);
			const instanceBody = await instanceRes.json();
			expect(instanceBody.status).toBe("active");

			// Step 4: Verify endpoint
			const endpointRes = await api(server, "GET", `/api/v1/instances/${instanceId}/endpoint`);
			expect(endpointRes.status).toBe(200);
			const endpointBody = await endpointRes.json();
			expect(endpointBody.endpoint).toBeDefined();
			expect(endpointBody.endpoint.host).toBeDefined();

			// Step 5: Verify instance is reachable (only if ports are exposed)
			if (endpointBody.endpoint.ports.length > 0 && rt.capabilities.networking) {
				const { host, ports } = endpointBody.endpoint;
				const instanceResponse = await fetch(`http://${host}:${ports[0]}`);
				expect(instanceResponse.ok).toBe(true);
			}

			// Step 6: Release tenant
			const releaseRes = await api(server, "POST", `/api/v1/tenants/${tenantId}/release`, { workload: workloadName });
			expect(releaseRes.status).toBe(200);

			// Step 7: Verify instance is no longer active
			const postReleaseRes = await api(server, "GET", `/api/v1/instances/${instanceId}`);
			expect(postReleaseRes.status).toBe(200);
			const postReleaseBody = await postReleaseRes.json();
			expect(["destroyed", "hibernated"]).toContain(postReleaseBody.status);

			// Step 8: Verify not in active list
			const activeListRes = await api(server, "GET", "/api/v1/instances?status=active");
			expect(activeListRes.status).toBe(200);
			const activeList = await activeListRes.json();
			const found = activeList.find(
				(i: { instanceId: string }) => i.instanceId === instanceId,
			);
			expect(found).toBeUndefined();

			// Step 9: Verify runtime resources cleaned up
			const isRunning = await rt.isInstanceRunning(instanceId);
			expect(isRunning).toBe(false);

			// Step 10: Verify activity log (skipped for external deployments)
			if (server.db) {
				const logs = server.db
					.select()
					.from(activityLog)
					.where(eq(activityLog.instanceId, instanceId as InstanceId))
					.all();
				expect(logs.length).toBeGreaterThanOrEqual(2);

				const events = logs.map((l) => l.event);
				expect(events).toContain("tenant.claimed");
			}
		}, timeouts.operation);
	});
}
