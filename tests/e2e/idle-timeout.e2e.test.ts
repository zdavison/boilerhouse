import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { generateTenantId, defineWorkload, resolveWorkloadConfig } from "@boilerhouse/core";
import { availableRuntimes, E2E_TIMEOUTS } from "./runtime-matrix";
import { startE2EServer, api, waitForWorkloadReady, type E2EServer } from "./e2e-helpers";

/** Idle timeout used in the workload fixture — short enough for tests. */
const IDLE_TIMEOUT_SECONDS = 2;

/** How long to poll for the instance to become idle (well beyond IDLE_TIMEOUT_SECONDS). */
const IDLE_WAIT_MS = 15_000;

/** Polls until the tenant's instanceId is null (idle fired and released). */
async function waitForIdle(server: E2EServer, tenantId: string): Promise<void> {
	const deadline = Date.now() + IDLE_WAIT_MS;
	while (Date.now() < deadline) {
		const res = await api(server, "GET", `/api/v1/tenants/${tenantId}`);
		if (res.ok) {
			const body = await res.json() as { instanceId: string | null }[];
			if (body[0]!.instanceId === null) return;
		}
		await new Promise((r) => setTimeout(r, 200));
	}
	throw new Error(`Tenant ${tenantId} did not go idle within ${IDLE_WAIT_MS}ms`);
}

for (const rt of availableRuntimes()) {
	const timeouts = E2E_TIMEOUTS[rt.name as keyof typeof E2E_TIMEOUTS] ?? E2E_TIMEOUTS.fake;

	describe(`[${rt.name}] idle timeout`, () => {
		let server: E2EServer;
		let workloadName: string;

		beforeAll(async () => {
			// Short poll interval so the idle timer fires promptly in tests.
			server = await startE2EServer(rt.name, { idlePollIntervalMs: 100 });

			const imageRef = rt.name === "fake"
				? "fake:latest"
				: "docker.io/library/alpine:3.21";

			const workload = resolveWorkloadConfig(defineWorkload({
				name: `e2e-idle-${rt.name}`,
				version: "1.0.0",
				image: { ref: imageRef },
				resources: { vcpus: 1, memory_mb: 128, disk_gb: 1 },
				network: { access: "none" },
				filesystem: { overlay_dirs: ["/data"] },
				idle: { action: "hibernate", timeout_seconds: IDLE_TIMEOUT_SECONDS },
				...(rt.name !== "fake" ? {
					entrypoint: { cmd: "/bin/sh", args: ["-c", "mkdir -p /data && while true; do sleep 1; done"] },
				} : {}),
			}));

			const registerRes = await api(server, "POST", "/api/v1/workloads", workload);
			expect(registerRes.status).toBe(201);
			const registerBody = await registerRes.json() as { name: string };
			workloadName = registerBody.name;

			await waitForWorkloadReady(server, workloadName);
		}, timeouts.operation);

		afterAll(async () => {
			if (server) await server.cleanup();
		});

		test(
			"instance is released automatically after idle timeout elapses",
			async () => {
				const tenantId = generateTenantId();

				// Claim a tenant — this starts the idle timer.
				const claimRes = await api(server, "POST", `/api/v1/tenants/${tenantId}/claim`, {
					workload: workloadName,
				});
				expect(claimRes.status).toBe(200);
				const claimBody = await claimRes.json() as { instanceId: string };
				const instanceId = claimBody.instanceId;

				// Wait for idle timeout to fire and the instance to be released.
				await waitForIdle(server, tenantId);

				// Tenant should have no active instance.
				const tenantRes = await api(server, "GET", `/api/v1/tenants/${tenantId}`);
				expect(tenantRes.status).toBe(200);
				const tenantBody = await tenantRes.json() as { instanceId: string | null }[];
				expect(tenantBody[0]!.instanceId).toBeNull();

				// Instance should be hibernated (overlay dirs present → hibernate path).
				const instanceRes = await api(server, "GET", `/api/v1/instances/${instanceId}`);
				expect(instanceRes.status).toBe(200);
				const instanceBody = await instanceRes.json() as { status: string };
				expect(instanceBody.status).toBe("hibernated");
			},
			timeouts.operation + IDLE_WAIT_MS,
		);
	});
}
