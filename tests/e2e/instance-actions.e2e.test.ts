import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test";
import { generateTenantId } from "@boilerhouse/core";
import type { Workload } from "@boilerhouse/core";
import { availableRuntimes, E2E_TIMEOUTS } from "./runtime-matrix";
import {
	startE2EServer,
	api,
	readFixture,
	waitForWorkloadReady,
	type E2EServer,
} from "./e2e-helpers";

/** Workload with overlay dirs — needed so hibernate actually saves state. */
const HIBERNATE_WORKLOAD: Workload = {
	workload: { name: "e2e-hibernate", version: "1.0.0" },
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
	const timeouts =
		E2E_TIMEOUTS[rt.name as keyof typeof E2E_TIMEOUTS] ?? E2E_TIMEOUTS.fake;

	describe(`[${rt.name}] instance actions (dashboard)`, () => {
		// Podman container cleanup in afterAll can exceed the default 5s hook timeout
		setDefaultTimeout(timeouts.operation);

		let server: E2EServer;
		let workloadName: string;
		let hibernateWorkloadName: string;

		beforeAll(async () => {
			server = await startE2EServer(rt.name);

			// Register the httpserver workload (for destroy/endpoint tests)
			const fixture = await readFixture(rt.workloadFixtures.httpserver);
			const registerRes = await api(server, "POST", "/api/v1/workloads", fixture);
			expect(registerRes.status).toBe(201);
			const body = await registerRes.json();
			workloadName = body.name;
			await waitForWorkloadReady(server, workloadName);

			// Register a workload with overlay dirs (for hibernate tests)
			if (rt.capabilities.tenantSnapshot) {
				const hibRegRes = await api(server, "POST", "/api/v1/workloads", HIBERNATE_WORKLOAD);
				expect(hibRegRes.status).toBe(201);
				hibernateWorkloadName = (await hibRegRes.json()).name;
				await waitForWorkloadReady(server, hibernateWorkloadName);
			}
		}, timeouts.operation);

		afterAll(async () => {
			if (server) await server.cleanup();
		});

		/**
		 * Helper: claim a tenant and return the instanceId.
		 */
		async function setupActiveInstance(wl?: string) {
			const tenantId = generateTenantId();
			const claimRes = await api(
				server,
				"POST",
				`/api/v1/tenants/${tenantId}/claim`,
				{ workload: wl ?? workloadName },
			);
			expect(claimRes.status).toBe(200);
			const { instanceId } = (await claimRes.json()) as {
				instanceId: string;
			};

			// Sanity: instance should be active
			const instanceRes = await api(
				server,
				"GET",
				`/api/v1/instances/${instanceId}`,
			);
			expect(instanceRes.status).toBe(200);
			expect((await instanceRes.json()).status).toBe("active");

			return { workloadName: wl ?? workloadName, instanceId, tenantId };
		}

		// ── Hibernate ────────────────────────────────────────────────────

		test.skipIf(!rt.capabilities.tenantSnapshot)(
			"hibernate active instance directly",
			async () => {
				const { instanceId, tenantId } = await setupActiveInstance(hibernateWorkloadName);

				// Hibernate — saves overlay data, destroys container
				const hibRes = await api(
					server,
					"POST",
					`/api/v1/instances/${instanceId}/hibernate`,
				);
				expect(hibRes.status).toBe(200);
				const hibBody = await hibRes.json();
				expect(hibBody.status).toBe("hibernated");

				// Instance should be hibernated
				const instanceRes = await api(
					server,
					"GET",
					`/api/v1/instances/${instanceId}`,
				);
				expect(instanceRes.status).toBe(200);
				expect((await instanceRes.json()).status).toBe("hibernated");

				// Tenant should be dissociated
				const tenantRes = await api(
					server,
					"GET",
					`/api/v1/tenants/${tenantId}`,
				);
				expect(tenantRes.status).toBe(200);
				const tenant = await tenantRes.json();
				expect(tenant[0].instanceId).toBeNull();

				// Overlay data should be saved
				expect(tenant[0].dataOverlayRef).toBeTruthy();
			},
		);

		// ── Destroy ──────────────────────────────────────────────────────

		test(
			"destroy active instance directly",
			async () => {
				const { instanceId, tenantId } = await setupActiveInstance();

				// Destroy
				const destroyRes = await api(
					server,
					"POST",
					`/api/v1/instances/${instanceId}/destroy`,
				);
				expect(destroyRes.status).toBe(200);
				expect((await destroyRes.json()).status).toBe("destroyed");

				// Instance should be destroyed
				const instanceRes = await api(
					server,
					"GET",
					`/api/v1/instances/${instanceId}`,
				);
				expect(instanceRes.status).toBe(200);
				expect((await instanceRes.json()).status).toBe("destroyed");

				// Tenant should be dissociated
				const tenantRes = await api(
					server,
					"GET",
					`/api/v1/tenants/${tenantId}`,
				);
				expect(tenantRes.status).toBe(200);
				expect((await tenantRes.json())[0].instanceId).toBeNull();

				// Runtime resources should be cleaned up
				const isRunning = await rt.isInstanceRunning(instanceId);
				expect(isRunning).toBe(false);
			},
		);

		test.skipIf(!rt.capabilities.tenantSnapshot)(
			"destroy hibernated instance",
			async () => {
				const { instanceId } = await setupActiveInstance(hibernateWorkloadName);

				// First hibernate
				const hibRes = await api(
					server,
					"POST",
					`/api/v1/instances/${instanceId}/hibernate`,
				);
				expect(hibRes.status).toBe(200);

				// Then destroy the hibernated instance
				const destroyRes = await api(
					server,
					"POST",
					`/api/v1/instances/${instanceId}/destroy`,
				);
				expect(destroyRes.status).toBe(200);
				expect((await destroyRes.json()).status).toBe("destroyed");

				// Verify destroyed
				const instanceRes = await api(
					server,
					"GET",
					`/api/v1/instances/${instanceId}`,
				);
				expect(instanceRes.status).toBe(200);
				expect((await instanceRes.json()).status).toBe("destroyed");
			},
		);

		// ── Invalid transitions (409) ────────────────────────────────────

		test.skipIf(!rt.capabilities.tenantSnapshot)(
			"hibernate already-hibernated instance returns 404",
			async () => {
				const { instanceId } = await setupActiveInstance(hibernateWorkloadName);

				// First hibernate succeeds
				const hib1 = await api(
					server,
					"POST",
					`/api/v1/instances/${instanceId}/hibernate`,
				);
				expect(hib1.status).toBe(200);

				// Second hibernate should fail — no active claim exists
				const hib2 = await api(
					server,
					"POST",
					`/api/v1/instances/${instanceId}/hibernate`,
				);
				expect(hib2.status).toBe(404);
			},
		);

		test(
			"destroy already-destroyed instance returns 409",
			async () => {
				const { instanceId } = await setupActiveInstance();

				// First destroy succeeds
				const dest1 = await api(
					server,
					"POST",
					`/api/v1/instances/${instanceId}/destroy`,
				);
				expect(dest1.status).toBe(200);

				// Second destroy should fail with 409
				const dest2 = await api(
					server,
					"POST",
					`/api/v1/instances/${instanceId}/destroy`,
				);
				expect(dest2.status).toBe(409);
			},
		);

		// ── Endpoint ─────────────────────────────────────────────────────

		test(
			"get endpoint for active instance",
			async () => {
				const { instanceId } = await setupActiveInstance();

				const epRes = await api(
					server,
					"GET",
					`/api/v1/instances/${instanceId}/endpoint`,
				);
				expect(epRes.status).toBe(200);
				const epBody = await epRes.json();
				expect(epBody.endpoint).toBeDefined();
				expect(epBody.endpoint.host).toBeDefined();

				// If the runtime supports networking and ports are exposed, verify reachability
				if (
					rt.capabilities.networking &&
					epBody.endpoint?.ports?.length > 0
				) {
					const { host, ports } = epBody.endpoint;
					const resp = await fetch(`http://${host}:${ports[0]}`);
					expect(resp.ok).toBe(true);
				}
			},
		);

		test(
			"get endpoint for destroyed instance returns 409",
			async () => {
				const { instanceId } = await setupActiveInstance();

				// Destroy first
				const destroyRes = await api(
					server,
					"POST",
					`/api/v1/instances/${instanceId}/destroy`,
				);
				expect(destroyRes.status).toBe(200);

				// Endpoint on destroyed instance should fail
				const epRes = await api(
					server,
					"GET",
					`/api/v1/instances/${instanceId}/endpoint`,
				);
				expect(epRes.status).toBe(409);
			},
		);
	});
}
