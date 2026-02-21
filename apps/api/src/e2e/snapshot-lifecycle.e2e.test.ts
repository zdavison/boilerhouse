import { describe, test, expect, afterEach } from "bun:test";
import { availableRuntimes, E2E_TIMEOUTS } from "./runtime-matrix";
import { startE2EServer, api, readFixture, type E2EServer } from "./e2e-helpers";

for (const rt of availableRuntimes()) {
	const timeouts = E2E_TIMEOUTS[rt.name as keyof typeof E2E_TIMEOUTS] ?? E2E_TIMEOUTS.fake;

	describe(`[${rt.name}] snapshot lifecycle`, () => {
		let server: E2EServer;

		afterEach(async () => {
			if (server) await server.cleanup();
		});

		test.skipIf(!rt.capabilities.snapshot)("release hibernates, re-claim restores from snapshot", async () => {
			server = await startE2EServer(rt.name);
			const toml = await readFixture(rt.workloadFixture);

			// Step 1: Register workload (idle.action = "hibernate" in fixture)
			const registerRes = await api(server, "POST", "/api/v1/workloads", toml);
			expect(registerRes.status).toBe(201);
			const registerBody = await registerRes.json();
			const workloadName = registerBody.name;

			// Step 2: Verify golden snapshot exists
			const snapshotsRes = await api(server, "GET", `/api/v1/workloads/${workloadName}/snapshots`);
			expect(snapshotsRes.status).toBe(200);
			const snapshotsList = await snapshotsRes.json();
			const golden = snapshotsList.find((s: { type: string }) => s.type === "golden");
			expect(golden).toBeDefined();

			// Step 3: Claim tenant
			const claimRes = await api(server, "POST", "/api/v1/tenants/e2e-snap-1/claim", {
				workload: workloadName,
			});
			expect(claimRes.status).toBe(200);
			const claimBody = await claimRes.json();
			const instanceId = claimBody.instanceId as string;
			expect(claimBody.source).toBe("golden");

			// Step 4: Release tenant (workload idle.action = "hibernate", so this hibernates)
			const releaseRes = await api(server, "POST", "/api/v1/tenants/e2e-snap-1/release");
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
					s.type === "tenant" && s.tenantId === "e2e-snap-1",
			);
			expect(tenantSnap).toBeDefined();

			// Step 7: Re-claim — should restore from snapshot
			const claim2Res = await api(server, "POST", "/api/v1/tenants/e2e-snap-1/claim", {
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

			// Step 9: Verify reachable (skip if no networking)
			if (rt.capabilities.networking) {
				const endpoint2Body = await endpoint2Res.json();
				const { host, port } = endpoint2Body.endpoint;
				const resp = await fetch(`http://${host}:${port}`);
				expect(resp.ok).toBe(true);
			}

			// Step 10: Clean teardown
			const release2Res = await api(server, "POST", "/api/v1/tenants/e2e-snap-1/release");
			expect(release2Res.status).toBe(200);
		}, timeouts.operation);
	});
}
