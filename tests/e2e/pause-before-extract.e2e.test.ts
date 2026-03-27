import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { generateTenantId } from "@boilerhouse/core";
import type { Runtime } from "@boilerhouse/core";
import { availableRuntimes, E2E_TIMEOUTS } from "./runtime-matrix";
import { startE2EServer, api, waitForWorkloadReady, type E2EServer } from "./e2e-helpers";
import type { Workload } from "@boilerhouse/core";

/**
 * Simple workload with an overlay dir for testing the pause-before-extract
 * invariant. Uses alpine with a sleep loop.
 */
const OVERLAY_WORKLOAD: Workload = {
	workload: { name: "e2e-pause-extract", version: "1.0.0" },
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

/**
 * Wraps a Runtime, recording every method call in order.
 * Used to assert that `pause` is always called before `extractOverlayArchive`.
 */
function instrumentRuntime(runtime: Runtime): Runtime & { calls: string[] } {
	const calls: string[] = [];

	return new Proxy(runtime, {
		get(target, prop, receiver) {
			const value = Reflect.get(target, prop, receiver);
			if (typeof value !== "function") {
				if (prop === "calls") return calls;
				return value;
			}
			return function (this: unknown, ...args: unknown[]) {
				calls.push(prop as string);
				return (value as Function).apply(target, args);
			};
		},
	}) as Runtime & { calls: string[] };
}

for (const rt of availableRuntimes()) {
	if (!rt.capabilities.tenantSnapshot) continue;

	const timeouts = E2E_TIMEOUTS[rt.name as keyof typeof E2E_TIMEOUTS] ?? E2E_TIMEOUTS.fake;

	describe(`[${rt.name}] pause-before-extract invariant`, () => {
		let server: E2EServer;
		let workloadName: string;
		let instrumented: Runtime & { calls: string[] };

		beforeAll(async () => {
			server = await startE2EServer(rt.name, {
				runtimeInterceptor(runtime) {
					instrumented = instrumentRuntime(runtime);
					return instrumented;
				},
			});

			const registerRes = await api(server, "POST", "/api/v1/workloads", OVERLAY_WORKLOAD);
			expect(registerRes.status).toBe(201);
			const body = await registerRes.json();
			workloadName = body.name;

			await waitForWorkloadReady(server, workloadName, timeouts.operation);
		}, timeouts.operation);

		afterAll(async () => {
			if (server) await server.cleanup();
		});

		test("runtime.pause is called before overlay extraction during release", async () => {
			const tenantId = generateTenantId();

			// 1. Claim
			const claimRes = await api(server, "POST", `/api/v1/tenants/${tenantId}/claim`, {
				workload: workloadName,
			});
			expect(claimRes.status).toBe(200);
			const { instanceId } = await claimRes.json();

			// 2. Write data so overlay extraction actually runs
			const writeRes = await api(
				server,
				"POST",
				`/api/v1/instances/${instanceId}/exec`,
				{ command: ["sh", "-c", "echo 'freeze-test' > /data/freeze.txt"] },
			);
			expect(writeRes.status).toBe(200);

			// 3. Clear call log before release
			instrumented.calls.length = 0;

			// 4. Release — triggers overlay extraction
			const releaseRes = await api(server, "POST", `/api/v1/tenants/${tenantId}/release`, {
				workload: workloadName,
			});
			expect(releaseRes.status).toBe(200);

			// 5. Verify pause was called before extractOverlayArchive
			const pauseIdx = instrumented.calls.indexOf("pause");
			const extractIdx = instrumented.calls.indexOf("extractOverlayArchive");

			expect(pauseIdx).not.toBe(-1);
			expect(extractIdx).not.toBe(-1);
			expect(pauseIdx).toBeLessThan(extractIdx);

			// 6. Verify unpause was called after extraction (cleanup)
			const unpauseIdx = instrumented.calls.indexOf("unpause");
			expect(unpauseIdx).not.toBe(-1);
			expect(unpauseIdx).toBeGreaterThan(extractIdx);
		}, timeouts.operation);
	});
}
