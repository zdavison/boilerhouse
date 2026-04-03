import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { eq, and, inArray } from "drizzle-orm";
import { generateTenantId } from "@boilerhouse/core";
import { instances, workloads } from "@boilerhouse/db";
import { availableRuntimes, E2E_TIMEOUTS } from "./runtime-matrix";
import { startE2EServer, api, readFixture, waitForWorkloadReady, type E2EServer } from "./e2e-helpers";

for (const rt of availableRuntimes()) {
	const timeouts = E2E_TIMEOUTS[rt.name as keyof typeof E2E_TIMEOUTS] ?? E2E_TIMEOUTS.fake;

	describe(`[${rt.name}] workload live update (API)`, () => {
		let server: E2EServer;
		let workloadName: string;
		let fixture: Awaited<ReturnType<typeof readFixture>>;

		beforeAll(async () => {
			server = await startE2EServer(rt.name);
			fixture = await readFixture(rt.workloadFixtures.httpserver);

			const registerRes = await api(server, "POST", "/api/v1/workloads", fixture);
			expect(registerRes.status).toBe(201);
			const body = await registerRes.json();
			workloadName = body.name;

			await waitForWorkloadReady(server, workloadName);
		}, timeouts.operation);

		afterAll(async () => {
			if (server) await server.cleanup();
		});

		test("unchanged workload update is a no-op", async () => {
			// Get current state
			const beforeRes = await api(server, "GET", `/api/v1/workloads/${workloadName}`);
			expect(beforeRes.status).toBe(200);
			const before = await beforeRes.json();

			// PUT identical config
			const updateRes = await api(server, "PUT", `/api/v1/workloads/${workloadName}`, fixture);
			expect(updateRes.status).toBe(200);
			const updateBody = await updateRes.json();
			expect(updateBody.changed).toBe(false);

			// Workload should still be ready (not re-creating)
			const afterRes = await api(server, "GET", `/api/v1/workloads/${workloadName}`);
			expect(afterRes.status).toBe(200);
			const after = await afterRes.json();
			expect(after.status).toBe("ready");
			expect(after.updatedAt).toBe(before.updatedAt);
		}, timeouts.operation);

		test("updated workload goes through healthcheck before replacing pool", async () => {
			// This test verifies internal pool state via the DB — skipped for external deployments
			if (!server.db) return;

			// Modify the workload config (change resource limits)
			const updatedFixture = {
				...fixture,
				resources: { ...fixture.resources, memory_mb: 512 },
			};

			// Record pool instances before update
			const workloadRow = server.db
				.select()
				.from(workloads)
				.where(eq(workloads.name, workloadName))
				.get()!;
			const poolBefore = server.db
				.select()
				.from(instances)
				.where(
					and(
						eq(instances.workloadId, workloadRow.workloadId),
						inArray(instances.poolStatus, ["warming", "ready"]),
					),
				)
				.all();

			// PUT updated config
			const updateRes = await api(server, "PUT", `/api/v1/workloads/${workloadName}`, updatedFixture);
			expect(updateRes.status).toBe(200);
			const updateBody = await updateRes.json();
			expect(updateBody.changed).toBe(true);

			// Workload should transition through creating -> ready
			await waitForWorkloadReady(server, workloadName);

			// After becoming ready, old pool instances should be gone
			for (const oldInstance of poolBefore) {
				const row = server.db
					.select()
					.from(instances)
					.where(eq(instances.instanceId, oldInstance.instanceId))
					.get();
				expect(row?.status).toBe("destroyed");
			}

			// New pool instances should exist with the updated config
			const poolAfter = server.db
				.select()
				.from(instances)
				.where(
					and(
						eq(instances.workloadId, workloadRow.workloadId),
						inArray(instances.poolStatus, ["warming", "ready"]),
					),
				)
				.all();
			expect(poolAfter.length).toBeGreaterThan(0);

			// Pool instance IDs should be different from the old ones
			const oldIds = new Set(poolBefore.map((i) => i.instanceId));
			for (const inst of poolAfter) {
				expect(oldIds.has(inst.instanceId)).toBe(false);
			}
		}, timeouts.operation);

		test("claimed instances are untouched during workload update", async () => {
			const tenantId = generateTenantId();

			// Claim an instance
			const claimRes = await api(server, "POST", `/api/v1/tenants/${tenantId}/claim`, {
				workload: workloadName,
			});
			expect(claimRes.status).toBe(200);
			const claimBody = await claimRes.json();
			const claimedInstanceId = claimBody.instanceId;

			// Update the workload
			const updatedFixture = {
				...fixture,
				resources: { ...fixture.resources, memory_mb: 384 },
			};
			const updateRes = await api(server, "PUT", `/api/v1/workloads/${workloadName}`, updatedFixture);
			expect(updateRes.status).toBe(200);

			await waitForWorkloadReady(server, workloadName);

			// Claimed instance should still be active and untouched
			const instanceRes = await api(server, "GET", `/api/v1/instances/${claimedInstanceId}`);
			expect(instanceRes.status).toBe(200);
			const instanceBody = await instanceRes.json();
			expect(instanceBody.status).toBe("active");

			// Clean up
			await api(server, "POST", `/api/v1/tenants/${tenantId}/release`, {
				workload: workloadName,
			});
		}, timeouts.operation);

		test("new claims after update get the new workload config", async () => {
			const updatedFixture = {
				...fixture,
				resources: { ...fixture.resources, memory_mb: 768 },
			};

			const updateRes = await api(server, "PUT", `/api/v1/workloads/${workloadName}`, updatedFixture);
			expect(updateRes.status).toBe(200);
			await waitForWorkloadReady(server, workloadName);

			// Verify the stored workload config was updated
			const workloadRes = await api(server, "GET", `/api/v1/workloads/${workloadName}`);
			expect(workloadRes.status).toBe(200);
			const workloadBody = await workloadRes.json();
			expect(workloadBody.config.resources.memory_mb).toBe(768);

			// New claim should work with the updated workload
			const tenantId = generateTenantId();
			const claimRes = await api(server, "POST", `/api/v1/tenants/${tenantId}/claim`, {
				workload: workloadName,
			});
			expect(claimRes.status).toBe(200);
			const claimBody = await claimRes.json();
			expect(claimBody.instanceId).toBeDefined();

			const instanceRes = await api(server, "GET", `/api/v1/instances/${claimBody.instanceId}`);
			expect(instanceRes.status).toBe(200);
			const instanceBody = await instanceRes.json();
			expect(instanceBody.status).toBe("active");

			// Clean up
			await api(server, "POST", `/api/v1/tenants/${tenantId}/release`, {
				workload: workloadName,
			});
		}, timeouts.operation);

		test("update that fails healthcheck does not replace pool", async () => {
			// Inject a runtime failure so the prime/healthcheck fails
			if (server.fakeFailOn) {
				server.fakeFailOn.add("create");
			}

			const brokenFixture = {
				...fixture,
				resources: { ...fixture.resources, memory_mb: 999 },
			};
			const updateRes = await api(server, "PUT", `/api/v1/workloads/${workloadName}`, brokenFixture);
			expect(updateRes.status).toBe(200);

			// Wait for the workload to enter error state
			const start = Date.now();
			let workloadStatus = "";
			while (Date.now() - start < timeouts.operation - 1000) {
				const res = await api(server, "GET", `/api/v1/workloads/${workloadName}`);
				const body = await res.json();
				workloadStatus = body.status;
				if (workloadStatus === "error") break;
				await new Promise((r) => setTimeout(r, 100));
			}
			expect(workloadStatus).toBe("error");

			// Remove the failure injection
			if (server.fakeFailOn) {
				server.fakeFailOn.delete("create");
			}
		}, timeouts.operation);
	});
}
