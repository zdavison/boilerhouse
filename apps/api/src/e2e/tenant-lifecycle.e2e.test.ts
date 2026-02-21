import { describe, test, expect, afterEach } from "bun:test";
import { eq } from "drizzle-orm";
import type { TenantId } from "@boilerhouse/core";
import { activityLog } from "@boilerhouse/db";
import { availableRuntimes, E2E_TIMEOUTS } from "./runtime-matrix";
import { startE2EServer, api, readFixture, waitForWorkloadReady, type E2EServer } from "./e2e-helpers";

for (const rt of availableRuntimes()) {
	const timeouts = E2E_TIMEOUTS[rt.name as keyof typeof E2E_TIMEOUTS] ?? E2E_TIMEOUTS.fake;

	describe(`[${rt.name}] tenant lifecycle`, () => {
		let server: E2EServer;

		afterEach(async () => {
			if (server) await server.cleanup();
		});

		test("full claim/release cycle with snapshot restore", async () => {
			server = await startE2EServer(rt.name);
			const toml = await readFixture(rt.workloadFixture);

			// Step 1: Register workload
			const registerRes = await api(server, "POST", "/api/v1/workloads", toml);
			expect(registerRes.status).toBe(201);
			const registerBody = await registerRes.json();
			const workloadName = registerBody.name;

			await waitForWorkloadReady(server, workloadName);

			// Step 2: Verify golden snapshot exists
			const snapshotsRes = await api(server, "GET", `/api/v1/workloads/${workloadName}/snapshots`);
			expect(snapshotsRes.status).toBe(200);
			const snapshotsList = await snapshotsRes.json();
			expect(snapshotsList.length).toBeGreaterThanOrEqual(1);
			const goldenSnapshot = snapshotsList.find((s: { type: string }) => s.type === "golden");
			expect(goldenSnapshot).toBeDefined();

			// Step 3: First claim
			const claim1Res = await api(server, "POST", "/api/v1/tenants/e2e-tenant-1/claim", {
				workload: workloadName,
			});
			expect(claim1Res.status).toBe(200);
			const claim1Body = await claim1Res.json();
			expect(claim1Body.source).toBe("golden");
			expect(claim1Body.endpoint).toBeDefined();
			const firstInstanceId = claim1Body.instanceId as string;

			// Step 4: Verify tenant details
			const tenantRes = await api(server, "GET", "/api/v1/tenants/e2e-tenant-1");
			expect(tenantRes.status).toBe(200);
			const tenantBody = await tenantRes.json();
			expect(tenantBody.instanceId).toBe(firstInstanceId);
			expect(tenantBody.instance).toBeDefined();
			expect(tenantBody.instance.status).toBe("active");

			// Step 5: Verify instance reachable (skip if no networking)
			if (rt.capabilities.networking) {
				const { host, port } = claim1Body.endpoint;
				const resp = await fetch(`http://${host}:${port}`);
				expect(resp.ok).toBe(true);
			}

			// Step 6: Release tenant
			const release1Res = await api(server, "POST", "/api/v1/tenants/e2e-tenant-1/release");
			expect(release1Res.status).toBe(200);

			// Step 7: Verify tenant instanceId cleared
			const tenant2Res = await api(server, "GET", "/api/v1/tenants/e2e-tenant-1");
			expect(tenant2Res.status).toBe(200);
			const tenant2Body = await tenant2Res.json();
			expect(tenant2Body.instanceId).toBeNull();

			// Step 8: Verify first instance is no longer active
			const instance1Res = await api(server, "GET", `/api/v1/instances/${firstInstanceId}`);
			expect(instance1Res.status).toBe(200);
			const instance1Body = await instance1Res.json();
			expect(["destroyed", "hibernated"]).toContain(instance1Body.status);

			// Step 9: For snapshot-capable runtimes, verify lastSnapshotId is set
			if (rt.capabilities.snapshot) {
				expect(tenant2Body.lastSnapshotId).toBeDefined();
				expect(tenant2Body.lastSnapshotId).not.toBeNull();
			}

			// Step 10: Second claim — should restore from snapshot if capable
			const claim2Res = await api(server, "POST", "/api/v1/tenants/e2e-tenant-1/claim", {
				workload: workloadName,
			});
			expect(claim2Res.status).toBe(200);
			const claim2Body = await claim2Res.json();

			if (rt.capabilities.snapshot) {
				expect(claim2Body.source).toBe("snapshot");
			}
			expect(claim2Body.instanceId).not.toBe(firstInstanceId);

			// Step 11: Release second claim
			const release2Res = await api(server, "POST", "/api/v1/tenants/e2e-tenant-1/release");
			expect(release2Res.status).toBe(200);

			// Step 12: Verify activity log trail
			const logs = server.db
				.select()
				.from(activityLog)
				.where(eq(activityLog.tenantId, "e2e-tenant-1" as TenantId))
				.all();
			const events = logs.map((l) => l.event);
			expect(events).toContain("tenant.claimed");
			expect(events).toContain("tenant.released");
		}, timeouts.operation);
	});
}
