import { describe, test, expect, afterEach } from "bun:test";
import { availableRuntimes, E2E_TIMEOUTS } from "./runtime-matrix";
import { startE2EServer, api, readFixture, type E2EServer } from "./e2e-helpers";

for (const rt of availableRuntimes()) {
	const timeouts = E2E_TIMEOUTS[rt.name as keyof typeof E2E_TIMEOUTS] ?? E2E_TIMEOUTS.fake;

	describe(`[${rt.name}] error recovery`, () => {
		let server: E2EServer;

		afterEach(async () => {
			if (server) await server.cleanup();
		});

		test("failed instance creation leaves no orphans, system recovers", async () => {
			server = await startE2EServer(rt.name);
			const brokenToml = await readFixture(rt.brokenWorkloadFixture);
			const workingToml = await readFixture(rt.workloadFixture);

			// For fake runtime, inject failure on "start" operation
			if (rt.name === "fake" && server.fakeFailOn) {
				server.fakeFailOn.add("start");
			}

			// Step 1: Register broken workload (parsing succeeds, failure at instance create)
			const brokenRegRes = await api(server, "POST", "/api/v1/workloads", brokenToml);
			// Golden snapshot creation may fail, but workload itself registers.
			// For fake with failOn: the whole POST may return 201 (workload saved)
			// but golden snapshot creation failed silently.
			expect(brokenRegRes.status).toBe(201);

			const brokenBody = await brokenRegRes.json();
			const brokenWorkloadName = brokenBody.name;

			// Step 2: Claim a tenant — should fail
			const claimRes = await api(server, "POST", "/api/v1/tenants/e2e-err-1/claim", {
				workload: brokenWorkloadName,
			});
			// For fake with failOn: NoGoldenSnapshotError (503) since golden creation failed
			// For docker: instance creation fails (error propagates as 500 or similar)
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
			const workingRegRes = await api(server, "POST", "/api/v1/workloads", workingToml);
			expect(workingRegRes.status).toBe(201);
			const workingBody = await workingRegRes.json();

			const claimRecoverRes = await api(server, "POST", "/api/v1/tenants/e2e-err-recover/claim", {
				workload: workingBody.name,
			});
			expect(claimRecoverRes.status).toBe(200);
			const recoverBody = await claimRecoverRes.json();
			expect(recoverBody.instanceId).toBeDefined();

			// Step 7: Clean teardown
			const releaseRes = await api(server, "POST", "/api/v1/tenants/e2e-err-recover/release");
			expect(releaseRes.status).toBe(200);
		}, timeouts.operation);
	});
}
