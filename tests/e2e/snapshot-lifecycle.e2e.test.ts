import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { generateTenantId } from "@boilerhouse/core";
import { availableRuntimes, E2E_TIMEOUTS } from "./runtime-matrix";
import { startE2EServer, api, readFixture, waitForWorkloadReady, type E2EServer } from "./e2e-helpers";

for (const rt of availableRuntimes()) {
	const timeouts = E2E_TIMEOUTS[rt.name as keyof typeof E2E_TIMEOUTS] ?? E2E_TIMEOUTS.fake;

	describe(`[${rt.name}] snapshot lifecycle`, () => {
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

		test.skipIf(!rt.capabilities.tenantSnapshot)("release hibernates, re-claim restores from snapshot", async () => {
			const tenantId = generateTenantId();

			// Step 2: Verify golden snapshot exists (only for golden-capable runtimes)
			if (rt.capabilities.goldenSnapshot) {
				const snapshotsRes = await api(server, "GET", `/api/v1/workloads/${workloadName}/snapshots`);
				expect(snapshotsRes.status).toBe(200);
				const snapshotsList = await snapshotsRes.json();
				const golden = snapshotsList.find((s: { type: string }) => s.type === "golden");
				expect(golden).toBeDefined();
			}

			// Step 3: Claim tenant
			const claimRes = await api(server, "POST", `/api/v1/tenants/${tenantId}/claim`, {
				workload: workloadName,
			});
			expect(claimRes.status).toBe(200);
			const claimBody = await claimRes.json();
			const instanceId = claimBody.instanceId as string;
			expect(["golden", "cold"]).toContain(claimBody.source);

			// Step 4: Release tenant (workload idle.action = "hibernate", so this hibernates)
			const releaseRes = await api(server, "POST", `/api/v1/tenants/${tenantId}/release`);
			expect(releaseRes.status).toBe(200);

			// Step 5: Verify instance is hibernated
			const instanceRes = await api(server, "GET", `/api/v1/instances/${instanceId}`);
			expect(instanceRes.status).toBe(200);
			expect((await instanceRes.json()).status).toBe("hibernated");

			// Step 6: Verify tenant snapshot exists in snapshots list
			const allSnapshotsRes = await api(server, "GET", "/api/v1/snapshots");
			expect(allSnapshotsRes.status).toBe(200);
			const allSnapshots = await allSnapshotsRes.json();
			const tenantSnap = allSnapshots.find(
				(s: { type: string; tenantId: string | null }) =>
					s.type === "tenant" && s.tenantId === tenantId,
			);
			expect(tenantSnap).toBeDefined();

			// Step 7: Re-claim — should restore from snapshot
			const claim2Res = await api(server, "POST", `/api/v1/tenants/${tenantId}/claim`, {
				workload: workloadName,
			});
			expect(claim2Res.status).toBe(200);
			const claim2Body = await claim2Res.json();
			expect(claim2Body.source).toBe("snapshot");
			expect(claim2Body.instanceId).not.toBe(instanceId);

			const newInstanceId = claim2Body.instanceId as string;

			// Step 8: Verify new instance has endpoint
			const endpoint2Res = await api(server, "GET", `/api/v1/instances/${newInstanceId}/endpoint`);
			expect(endpoint2Res.status).toBe(200);

			// Step 9: Verify reachable (only for real runtimes with ports)
			const endpoint2Body = await endpoint2Res.json();
			if (rt.capabilities.networking && endpoint2Body.endpoint?.ports?.length > 0) {
				const { host, ports } = endpoint2Body.endpoint;
				const resp = await fetch(`http://${host}:${ports[0]}`);
				expect(resp.ok).toBe(true);
			}

			// Step 10: Clean teardown
			const release2Res = await api(server, "POST", `/api/v1/tenants/${tenantId}/release`);
			expect(release2Res.status).toBe(200);
		}, timeouts.operation);
	});
}
