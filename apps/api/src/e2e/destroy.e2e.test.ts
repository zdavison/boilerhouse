import { describe, test, expect, afterEach } from "bun:test";
import { availableRuntimes, E2E_TIMEOUTS } from "./runtime-matrix";
import { startE2EServer, api, readFixture, waitForWorkloadReady, type E2EServer } from "./e2e-helpers";

for (const rt of availableRuntimes()) {
	const timeouts = E2E_TIMEOUTS[rt.name as keyof typeof E2E_TIMEOUTS] ?? E2E_TIMEOUTS.fake;

	describe(`[${rt.name}] destroy running instances`, () => {
		let server: E2EServer;

		afterEach(async () => {
			if (server) await server.cleanup();
		});

		test("destroy active instance, verify cannot operate on it", async () => {
			server = await startE2EServer(rt.name);
			const toml = await readFixture(rt.workloadFixture);

			// Step 1: Register workload and claim tenant
			const registerRes = await api(server, "POST", "/api/v1/workloads", toml);
			expect(registerRes.status).toBe(201);
			const { name: workloadName } = await registerRes.json();

			await waitForWorkloadReady(server, workloadName);

			const claimRes = await api(server, "POST", "/api/v1/tenants/e2e-destroy-1/claim", {
				workload: workloadName,
			});
			expect(claimRes.status).toBe(200);
			const { instanceId } = await claimRes.json();

			// Verify instance is active
			const instanceRes = await api(server, "GET", `/api/v1/instances/${instanceId}`);
			expect(instanceRes.status).toBe(200);
			expect((await instanceRes.json()).status).toBe("active");

			// Step 2: Destroy the instance
			const destroyRes = await api(server, "POST", `/api/v1/instances/${instanceId}/destroy`);
			expect(destroyRes.status).toBe(200);
			const destroyBody = await destroyRes.json();
			expect(destroyBody.status).toBe("destroyed");

			// Step 3: Verify instance is destroyed
			const checkRes = await api(server, "GET", `/api/v1/instances/${instanceId}`);
			expect(checkRes.status).toBe(200);
			expect((await checkRes.json()).status).toBe("destroyed");

			// Step 4: Stop on destroyed instance should fail
			const stopRes = await api(server, "POST", `/api/v1/instances/${instanceId}/stop`);
			expect(stopRes.status).not.toBe(200);

			// Step 5: Hibernate on destroyed instance should fail
			const hibernateRes = await api(server, "POST", `/api/v1/instances/${instanceId}/hibernate`);
			expect(hibernateRes.status).not.toBe(200);

			// Step 6: Runtime resources cleaned up
			const isRunning = await rt.isInstanceRunning(instanceId);
			expect(isRunning).toBe(false);
		}, timeouts.operation);
	});
}
