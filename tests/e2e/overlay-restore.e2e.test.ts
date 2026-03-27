import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { generateTenantId } from "@boilerhouse/core";
import { tenants } from "@boilerhouse/db";
import { availableRuntimes, E2E_TIMEOUTS } from "./runtime-matrix";
import { startE2EServer, api, waitForWorkloadReady, type E2EServer } from "./e2e-helpers";
import type { Workload } from "@boilerhouse/core";

/**
 * Workload with an overlay directory and hibernate idle action.
 * The /data overlay dir persists tenant data across snapshot expiration.
 */
const OVERLAY_WORKLOAD: Workload = {
	workload: { name: "e2e-overlay-restore", version: "1.0.0" },
	image: { ref: "docker.io/library/alpine:3.21" },
	resources: { vcpus: 1, memory_mb: 128, disk_gb: 2 },
	network: { access: "none" },
	filesystem: { overlay_dirs: ["/data"] },
	idle: { action: "hibernate" },
	entrypoint: {
		cmd: "/bin/sh",
		args: ["-c", "mkdir -p /data && while true; do sleep 1; done"],
	},
} as Workload;

for (const rt of availableRuntimes()) {
	// Only real runtimes with overlay persistence
	if (rt.name === "fake") continue;
	if (!rt.capabilities.tenantSnapshot) continue;

	const timeouts = E2E_TIMEOUTS[rt.name as keyof typeof E2E_TIMEOUTS] ?? E2E_TIMEOUTS.fake;

	describe(`[${rt.name}] overlay expiration`, () => {
		let server: E2EServer;
		let workloadName: string;

		beforeAll(async () => {
			server = await startE2EServer(rt.name);

			const registerRes = await api(server, "POST", "/api/v1/workloads", OVERLAY_WORKLOAD);
			expect(registerRes.status).toBe(201);
			const body = await registerRes.json();
			workloadName = body.name;

			await waitForWorkloadReady(server, workloadName, timeouts.operation);
		}, timeouts.operation);

		afterAll(async () => {
			if (server) await server.cleanup();
		});

		test(
			"expired overlay data is not restored on re-claim",
			async () => {
				const tenantId = generateTenantId();
				const testData = `overlay-test-${Date.now()}`;

				// 1. Claim tenant
				const claim1Res = await api(server, "POST", `/api/v1/tenants/${tenantId}/claim`, {
					workload: workloadName,
				});
				expect(claim1Res.status).toBe(200);
				const claim1Body = await claim1Res.json();
				const firstInstanceId = claim1Body.instanceId as string;

				// 2. Write data to overlay directory
				const writeRes = await api(
					server,
					"POST",
					`/api/v1/instances/${firstInstanceId}/exec`,
					{ command: ["sh", "-c", `echo '${testData}' > /data/persist.txt`] },
				);
				expect(writeRes.status).toBe(200);

				// 3. Verify data is there
				const readRes = await api(
					server,
					"POST",
					`/api/v1/instances/${firstInstanceId}/exec`,
					{ command: ["cat", "/data/persist.txt"] },
				);
				expect(readRes.status).toBe(200);
				expect((await readRes.json()).stdout).toContain(testData);

				// 4. Release tenant (extracts overlay data, destroys container)
				const releaseRes = await api(server, "POST", `/api/v1/tenants/${tenantId}/release`, { workload: workloadName });
				expect(releaseRes.status).toBe(200);

				// 5. Verify overlay data was saved
				const tenantRow = server.db
					.select({ dataOverlayRef: tenants.dataOverlayRef })
					.from(tenants)
					.where(eq(tenants.tenantId, tenantId))
					.get();
				expect(tenantRow?.dataOverlayRef).toBeTruthy();

				// 6. Expire the overlay — clear the reference (simulates storage TTL)
				server.db
					.update(tenants)
					.set({ dataOverlayRef: null })
					.where(eq(tenants.tenantId, tenantId))
					.run();

				// Verify overlay ref is gone
				const afterExpire = server.db
					.select({ dataOverlayRef: tenants.dataOverlayRef })
					.from(tenants)
					.where(eq(tenants.tenantId, tenantId))
					.get();
				expect(afterExpire?.dataOverlayRef).toBeNull();

				// 7. Re-claim — no overlay data, so cold boot (data is lost)
				const claim2Res = await api(server, "POST", `/api/v1/tenants/${tenantId}/claim`, {
					workload: workloadName,
				});
				expect(claim2Res.status).toBe(200);
				const claim2Body = await claim2Res.json();
				expect(["cold", "pool"]).toContain(claim2Body.source);
				expect(claim2Body.instanceId).not.toBe(firstInstanceId);

				const secondInstanceId = claim2Body.instanceId as string;

				// 8. Verify data is NOT present (overlay was expired)
				const readRes2 = await api(
					server,
					"POST",
					`/api/v1/instances/${secondInstanceId}/exec`,
					{ command: ["sh", "-c", "cat /data/persist.txt 2>&1 || echo __MISSING__"] },
				);
				expect(readRes2.status).toBe(200);
				const readBody2 = await readRes2.json();
				expect(readBody2.stdout).not.toContain(testData);

				// 9. Clean up
				const release2Res = await api(server, "POST", `/api/v1/tenants/${tenantId}/release`, { workload: workloadName });
				expect(release2Res.status).toBe(200);
			},
			timeouts.operation,
		);
	});
}
