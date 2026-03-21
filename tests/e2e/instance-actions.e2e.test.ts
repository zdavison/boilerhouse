import { describe, test, expect, beforeAll, afterAll, setDefaultTimeout } from "bun:test";
import { generateTenantId } from "@boilerhouse/core";
import { availableRuntimes, E2E_TIMEOUTS } from "./runtime-matrix";
import {
	startE2EServer,
	api,
	readFixture,
	waitForWorkloadReady,
	type E2EServer,
} from "./e2e-helpers";

for (const rt of availableRuntimes()) {
	const timeouts =
		E2E_TIMEOUTS[rt.name as keyof typeof E2E_TIMEOUTS] ?? E2E_TIMEOUTS.fake;

	describe(`[${rt.name}] instance actions (dashboard)`, () => {
		// Podman container cleanup in afterAll can exceed the default 5s hook timeout
		setDefaultTimeout(timeouts.operation);

		let server: E2EServer;
		let workloadName: string;

		beforeAll(async () => {
			server = await startE2EServer(rt.name);
			const fixture = await readFixture(rt.workloadFixtures.httpserver);

			const registerRes = await api(server, "POST", "/api/v1/workloads", fixture);
			expect(registerRes.status).toBe(201);
			const body = await registerRes.json();
			workloadName = body.name;

			await waitForWorkloadReady(server, workloadName);
		}, timeouts.operation);

		afterAll(async () => {
			if (server) await server.cleanup();
		});

		/**
		 * Helper: claim a tenant and return the instanceId.
		 * Relies on the workload already being registered and ready in beforeAll.
		 */
		async function setupActiveInstance() {
			const tenantId = generateTenantId();
			const claimRes = await api(
				server,
				"POST",
				`/api/v1/tenants/${tenantId}/claim`,
				{ workload: workloadName },
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

			return { workloadName, instanceId, tenantId };
		}

		// ── Hibernate ────────────────────────────────────────────────────

		test.skipIf(!rt.capabilities.tenantSnapshot)(
			"hibernate active instance directly",
			async () => {
				const { instanceId, tenantId } = await setupActiveInstance();

				// Hibernate
				const hibRes = await api(
					server,
					"POST",
					`/api/v1/instances/${instanceId}/hibernate`,
				);
				expect(hibRes.status).toBe(200);
				const hibBody = await hibRes.json();
				expect(hibBody.snapshotId).toBeDefined();

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
				expect(tenant.instanceId).toBeNull();
				expect(tenant.lastSnapshotId).toBe(hibBody.snapshotId);

				// Snapshot should exist
				const snapshotsRes = await api(server, "GET", "/api/v1/snapshots");
				expect(snapshotsRes.status).toBe(200);
				const snapshots = (await snapshotsRes.json()) as {
					snapshotId: string;
					type: string;
				}[];
				const tenantSnap = snapshots.find(
					(s) => s.snapshotId === hibBody.snapshotId,
				);
				expect(tenantSnap).toBeDefined();
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
				expect((await tenantRes.json()).instanceId).toBeNull();

				// Runtime resources should be cleaned up
				const isRunning = await rt.isInstanceRunning(instanceId);
				expect(isRunning).toBe(false);
			},
		);

		test.skipIf(!rt.capabilities.tenantSnapshot)(
			"destroy hibernated instance",
			async () => {
				const { instanceId } = await setupActiveInstance();

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
			"hibernate already-hibernated instance returns 409",
			async () => {
				const { instanceId } = await setupActiveInstance();

				// First hibernate succeeds
				const hib1 = await api(
					server,
					"POST",
					`/api/v1/instances/${instanceId}/hibernate`,
				);
				expect(hib1.status).toBe(200);

				// Second hibernate should fail with 409
				const hib2 = await api(
					server,
					"POST",
					`/api/v1/instances/${instanceId}/hibernate`,
				);
				expect(hib2.status).toBe(409);
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
