import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { generateTenantId } from "@boilerhouse/core";
import { availableRuntimes } from "./runtime-matrix";
import {
	startE2EServer,
	waitForWorkloadReady,
	api,
	readFixture,
	timeoutFor,
	type E2EServer,
} from "./e2e-helpers";

const runtimes = availableRuntimes().filter(
	(r) => r.capabilities.networking && r.capabilities.exec,
);

for (const entry of runtimes) {
	describe(`Secret Gateway [${entry.name}]`, () => {
		let server: E2EServer;
		let workloadName: string;
		const timeouts = timeoutFor(entry.name);

		beforeAll(async () => {
			// Ensure the global secret is available in the environment for golden boot
			process.env.ANTHROPIC_API_KEY ??= "sk-ant-e2e-global";

			server = await startE2EServer(entry.name);

			// Register openclaw workload (has network.credentials with global-secret)
			const fixture = await readFixture(entry.workloadFixtures.openclaw);
			const res = await api(server, "POST", "/api/v1/workloads", fixture);
			expect(res.status).toBe(201);

			const registerBody = await res.json();
			workloadName = registerBody.name;

			await waitForWorkloadReady(server, workloadName, timeouts.operation);
		}, 120_000);

		afterAll(async () => {
			await server?.cleanup();
		}, 30_000);

		test("tenant secrets API: set and list secrets", async () => {
			const tenantId = generateTenantId();

			// Set a tenant secret
			const setRes = await api(
				server,
				"PUT",
				`/api/v1/tenants/${tenantId}/secrets/MY_TENANT_KEY`,
				{ value: "sk-tenant-test-12345" },
			);
			expect(setRes.status).toBe(201);

			// List secrets (should return names only)
			const listRes = await api(
				server,
				"GET",
				`/api/v1/tenants/${tenantId}/secrets`,
			);
			expect(listRes.status).toBe(200);
			const body = (await listRes.json()) as { secrets: string[] };
			expect(body.secrets).toContain("MY_TENANT_KEY");
		});

		test("tenant secrets API: delete secret", async () => {
			const tenantId = generateTenantId();

			await api(
				server,
				"PUT",
				`/api/v1/tenants/${tenantId}/secrets/TEMP_KEY`,
				{ value: "temp-value" },
			);

			const delRes = await api(
				server,
				"DELETE",
				`/api/v1/tenants/${tenantId}/secrets/TEMP_KEY`,
			);
			expect(delRes.status).toBe(200);

			const listRes = await api(
				server,
				"GET",
				`/api/v1/tenants/${tenantId}/secrets`,
			);
			const body = (await listRes.json()) as { secrets: string[] };
			expect(body.secrets).not.toContain("TEMP_KEY");
		});

		test("container does not have secret values in env", async () => {
			const tenantId = generateTenantId();

			const claimRes = await api(
				server,
				"POST",
				`/api/v1/tenants/${tenantId}/claim`,
				{ workload: workloadName },
			);
			expect(claimRes.status).toBe(200);
			const claimBody = (await claimRes.json()) as {
				instanceId: string;
			};

			// Exec into container and check env
			const execRes = await api(
				server,
				"POST",
				`/api/v1/instances/${claimBody.instanceId}/exec`,
				{ command: ["printenv"] },
			);
			expect(execRes.status).toBe(200);
			const execBody = (await execRes.json()) as {
				exitCode: number;
				stdout: string;
			};

			// The real API key must NOT be in the container env
			expect(execBody.stdout).not.toContain("ANTHROPIC_API_KEY=sk-ant");

			// HTTP_PROXY should be present for runtimes that inject the sidecar proxy
			if (entry.name === "podman" || entry.name === "kubernetes") {
				expect(execBody.stdout).toContain("HTTP_PROXY=");
			}

			// Clean up
			await api(server, "POST", `/api/v1/tenants/${tenantId}/release`, { workload: workloadName });
		}, timeouts.operation * 2);
	});
}
