import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { generateTenantId } from "@boilerhouse/core";
import type { Workload } from "@boilerhouse/core";
import { availableRuntimes, E2E_TIMEOUTS } from "./runtime-matrix";
import { startE2EServer, api, waitForWorkloadReady, type E2EServer } from "./e2e-helpers";

/** Workload with overlay dirs so release hibernates (saves overlay data). */
const SNAPSHOT_WORKLOAD: Workload = {
	workload: { name: "e2e-snapshot", version: "1.0.0" },
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
	// Fake exec doesn't run real commands
	if (rt.name === "fake") continue;

	const timeouts = E2E_TIMEOUTS[rt.name as keyof typeof E2E_TIMEOUTS] ?? E2E_TIMEOUTS.fake;

	describe(`[${rt.name}] snapshot lifecycle`, () => {
		let server: E2EServer;
		let workloadName: string;

		beforeAll(async () => {
			server = await startE2EServer(rt.name);

			const registerRes = await api(server, "POST", "/api/v1/workloads", SNAPSHOT_WORKLOAD);
			expect(registerRes.status).toBe(201);
			const registerBody = await registerRes.json();
			workloadName = registerBody.name;

			await waitForWorkloadReady(server, workloadName);
		}, timeouts.operation);

		afterAll(async () => {
			if (server) await server.cleanup();
		});

		test.skipIf(!rt.capabilities.tenantSnapshot)("release hibernates, re-claim restores overlay data", async () => {
			const tenantId = generateTenantId();

			// 1. Claim tenant
			const claimRes = await api(server, "POST", `/api/v1/tenants/${tenantId}/claim`, {
				workload: workloadName,
			});
			expect(claimRes.status).toBe(200);
			const claimBody = await claimRes.json();
			const instanceId = claimBody.instanceId as string;

			// 2. Write data to overlay directory
			const writeRes = await api(server, "POST", `/api/v1/instances/${instanceId}/exec`, {
				command: ["sh", "-c", "echo 'snapshot-test-data' > /data/snapshot.txt"],
			});
			expect(writeRes.status).toBe(200);

			// 3. Release tenant (extracts overlay, hibernates)
			const releaseRes = await api(server, "POST", `/api/v1/tenants/${tenantId}/release`, { workload: workloadName });
			expect(releaseRes.status).toBe(200);

			// 4. Verify instance is hibernated (overlay saved)
			const instanceRes = await api(server, "GET", `/api/v1/instances/${instanceId}`);
			expect(instanceRes.status).toBe(200);
			expect((await instanceRes.json()).status).toBe("hibernated");

			// 5. Re-claim — should restore overlay data
			const claim2Res = await api(server, "POST", `/api/v1/tenants/${tenantId}/claim`, {
				workload: workloadName,
			});
			expect(claim2Res.status).toBe(200);
			const claim2Body = await claim2Res.json();
			expect(["cold+data", "pool+data"]).toContain(claim2Body.source);
			expect(claim2Body.instanceId).not.toBe(instanceId);

			const newInstanceId = claim2Body.instanceId as string;

			// 6. Verify data was restored
			const readRes = await api(server, "POST", `/api/v1/instances/${newInstanceId}/exec`, {
				command: ["cat", "/data/snapshot.txt"],
			});
			expect(readRes.status).toBe(200);
			const readBody = await readRes.json();
			expect(readBody.stdout).toContain("snapshot-test-data");

			// 7. Clean teardown
			const release2Res = await api(server, "POST", `/api/v1/tenants/${tenantId}/release`, { workload: workloadName });
			expect(release2Res.status).toBe(200);
		}, timeouts.operation);
	});
}
