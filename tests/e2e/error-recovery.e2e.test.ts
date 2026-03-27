import { describe, test, expect, afterEach, setDefaultTimeout } from "bun:test";
import { generateTenantId } from "@boilerhouse/core";
import { availableRuntimes, E2E_TIMEOUTS } from "./runtime-matrix";
import { startE2EServer, api, readFixture, waitForWorkloadReady, type E2EServer } from "./e2e-helpers";

for (const rt of availableRuntimes()) {
	const timeouts = E2E_TIMEOUTS[rt.name as keyof typeof E2E_TIMEOUTS] ?? E2E_TIMEOUTS.fake;

	describe(`[${rt.name}] error recovery`, () => {
		setDefaultTimeout(timeouts.operation);

		let server: E2EServer;

		afterEach(async () => {
			if (server) await server.cleanup();
		});

		test("failed instance creation leaves no orphans, system recovers", async () => {
			server = await startE2EServer(rt.name);
			const brokenWorkload = await readFixture(rt.brokenWorkloadFixture);
			const workingFixture = await readFixture(rt.workloadFixtures.httpserver);

			// For fake runtime, inject failure on "start" operation
			if (rt.name === "fake" && server.fakeFailOn) {
				server.fakeFailOn.add("start");
			}

			// Step 1: Register broken workload (parsing succeeds, failure at instance create)
			const brokenRegRes = await api(server, "POST", "/api/v1/workloads", brokenWorkload);
			// Workload registers with status "creating", golden creation fails in background
			expect(brokenRegRes.status).toBe(201);

			const brokenBody = await brokenRegRes.json();
			const brokenWorkloadName = brokenBody.name;

			// Wait for golden creation to fail (workload transitions to "error")
			const start = Date.now();
			while (Date.now() - start < 5000) {
				const res = await fetch(`${server.baseUrl}/api/v1/workloads/${brokenWorkloadName}`);
				const body = (await res.json()) as { status: string };
				if (body.status === "error") break;
				await new Promise((r) => setTimeout(r, 50));
			}

			// Step 2: Claim a tenant — should fail (workload not ready)
			const tenantId1 = generateTenantId();
			const claimRes = await api(server, "POST", `/api/v1/tenants/${tenantId1}/claim`, {
				workload: brokenWorkloadName,
			});
			// Workload is in "error" status, so claim returns 503
			expect(claimRes.status).not.toBe(200);

			// Step 3: No orphaned active instances
			const activeRes = await api(server, "GET", "/api/v1/instances?status=active");
			expect(activeRes.status).toBe(200);
			const activeInstances = await activeRes.json();
			expect(activeInstances.length).toBe(0);

			// Step 4: Stats are consistent
			const statsRes = await api(server, "GET", "/api/v1/stats");
			expect(statsRes.status).toBe(200);

			// Step 5: No orphaned runtime resources
			await rt.verifyCleanup();

			// Clear fake runtime failure before recovery
			if (rt.name === "fake" && server.fakeFailOn) {
				server.fakeFailOn.delete("start");
			}

			// Step 6: Register a working workload and claim — system recovered
			const workingRegRes = await api(server, "POST", "/api/v1/workloads", workingFixture);
			expect(workingRegRes.status).toBe(201);
			const workingBody = await workingRegRes.json();

			await waitForWorkloadReady(server, workingBody.name);

			const tenantId2 = generateTenantId();
			const claimRecoverRes = await api(server, "POST", `/api/v1/tenants/${tenantId2}/claim`, {
				workload: workingBody.name,
			});
			expect(claimRecoverRes.status).toBe(200);
			const recoverBody = await claimRecoverRes.json();
			expect(recoverBody.instanceId).toBeDefined();

			// Step 7: Clean teardown
			const releaseRes = await api(server, "POST", `/api/v1/tenants/${tenantId2}/release`, { workload: workingBody.name });
			expect(releaseRes.status).toBe(200);
		}, timeouts.operation);
	});
}
