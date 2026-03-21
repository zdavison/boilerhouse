import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { generateTenantId } from "@boilerhouse/core";
import { availableRuntimes, E2E_TIMEOUTS } from "./runtime-matrix";
import { startE2EServer, api, waitForWorkloadReady, type E2EServer } from "./e2e-helpers";
import type { Workload } from "@boilerhouse/core";

/**
 * Workload with an overlay directory and hibernate idle action.
 * Uses alpine with a sleep loop — the overlay dir is where tenant
 * data lives across release/re-claim cycles.
 */
const DATA_PERSISTENCE_WORKLOAD: Workload = {
	workload: { name: "e2e-data-persist", version: "1.0.0" },
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
	// Only real runtimes — fake exec doesn't run actual commands
	if (rt.name === "fake") continue;

	const timeouts = E2E_TIMEOUTS[rt.name as keyof typeof E2E_TIMEOUTS] ?? E2E_TIMEOUTS.fake;

	describe(`[${rt.name}] data persistence across release/re-claim`, () => {
		let server: E2EServer;
		let workloadName: string;

		beforeAll(async () => {
			server = await startE2EServer(rt.name);

			const registerRes = await api(server, "POST", "/api/v1/workloads", DATA_PERSISTENCE_WORKLOAD);
			expect(registerRes.status).toBe(201);
			const body = await registerRes.json();
			workloadName = body.name;

			await waitForWorkloadReady(server, workloadName);
		}, timeouts.operation);

		afterAll(async () => {
			if (server) await server.cleanup();
		});

		test("files written to overlay dir survive release and re-claim", async () => {
			const tenantId = generateTenantId();

			// 1. Claim tenant
			const claim1Res = await api(server, "POST", `/api/v1/tenants/${tenantId}/claim`, {
				workload: workloadName,
			});
			expect(claim1Res.status).toBe(200);
			const claim1Body = await claim1Res.json();
			const firstInstanceId = claim1Body.instanceId as string;

			// 2. Write a file into the overlay directory
			const writeRes = await api(
				server,
				"POST",
				`/api/v1/instances/${firstInstanceId}/exec`,
				{ command: ["sh", "-c", "echo 'tenant-data-12345' > /data/persist.txt"] },
			);
			expect(writeRes.status).toBe(200);

			// 3. Verify the file exists
			const readRes = await api(
				server,
				"POST",
				`/api/v1/instances/${firstInstanceId}/exec`,
				{ command: ["cat", "/data/persist.txt"] },
			);
			expect(readRes.status).toBe(200);
			const readBody = await readRes.json();
			expect(readBody.stdout).toContain("tenant-data-12345");

			// 4. Release tenant (idle.action="hibernate" → snapshots overlay, destroys)
			const releaseRes = await api(server, "POST", `/api/v1/tenants/${tenantId}/release`);
			expect(releaseRes.status).toBe(200);

			// 5. Verify instance is hibernated
			const instanceRes = await api(server, "GET", `/api/v1/instances/${firstInstanceId}`);
			expect(instanceRes.status).toBe(200);
			const instanceBody = await instanceRes.json();
			expect(instanceBody.status).toBe("hibernated");

			// 6. Re-claim — should restore from tenant snapshot
			const claim2Res = await api(server, "POST", `/api/v1/tenants/${tenantId}/claim`, {
				workload: workloadName,
			});
			expect(claim2Res.status).toBe(200);
			const claim2Body = await claim2Res.json();
			expect(claim2Body.source).toBe("snapshot");
			expect(claim2Body.instanceId).not.toBe(firstInstanceId);

			const secondInstanceId = claim2Body.instanceId as string;

			// 7. Verify the file persisted across the release/re-claim cycle
			const readRes2 = await api(
				server,
				"POST",
				`/api/v1/instances/${secondInstanceId}/exec`,
				{ command: ["cat", "/data/persist.txt"] },
			);
			expect(readRes2.status).toBe(200);
			const readBody2 = await readRes2.json();
			expect(readBody2.stdout).toContain("tenant-data-12345");

			// 8. Clean up
			const release2Res = await api(server, "POST", `/api/v1/tenants/${tenantId}/release`);
			expect(release2Res.status).toBe(200);
		}, timeouts.operation);
	});
}
