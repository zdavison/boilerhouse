import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { generateTenantId } from "@boilerhouse/core";
import { availableRuntimes, E2E_TIMEOUTS } from "./runtime-matrix";
import { startE2EServer, api, readFixture, waitForWorkloadReady, type E2EServer } from "./e2e-helpers";

interface DomainEvent {
	type: string;
	instanceId?: string;
	tenantId?: string;
	status?: string;
	source?: string;
	workloadId?: string;
}

for (const rt of availableRuntimes()) {
	const timeouts = E2E_TIMEOUTS[rt.name as keyof typeof E2E_TIMEOUTS] ?? E2E_TIMEOUTS.fake;

	describe(`[${rt.name}] EventBus / WebSocket integration`, () => {
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

		test("WebSocket receives domain events during claim/release", async () => {
			const tenantId = generateTenantId();

			// Step 1: Open WebSocket connection
			const wsUrl = server.baseUrl.replace("http://", "ws://") + "/ws";
			const events: DomainEvent[] = [];

			const ws = new WebSocket(wsUrl);
			await new Promise<void>((resolve, reject) => {
				ws.onopen = () => resolve();
				ws.onerror = (e) => reject(e);
			});

			ws.onmessage = (event) => {
				events.push(JSON.parse(event.data as string));
			};

			// Step 3: Claim tenant
			const claimRes = await api(server, "POST", `/api/v1/tenants/${tenantId}/claim`, {
				workload: workloadName,
			});
			expect(claimRes.status).toBe(200);
			const claimBody = await claimRes.json();

			// Brief delay to allow WS messages to arrive
			await new Promise((r) => setTimeout(r, 100));

			// Step 4: Verify tenant.claimed event received
			const claimEvent = events.find((e) => e.type === "tenant.claimed");
			expect(claimEvent).toBeDefined();
			expect(claimEvent!.tenantId).toBe(tenantId);
			expect(claimEvent!.instanceId).toBe(claimBody.instanceId);

			// Step 5: Release tenant
			const releaseRes = await api(server, "POST", `/api/v1/tenants/${tenantId}/release`, { workload: workloadName });
			expect(releaseRes.status).toBe(200);

			// Brief delay for WS events
			await new Promise((r) => setTimeout(r, 100));

			// Step 6: Verify tenant.released event
			const releaseEvent = events.find((e) => e.type === "tenant.released");
			expect(releaseEvent).toBeDefined();
			expect(releaseEvent!.tenantId).toBe(tenantId);

			// Step 7: Verify events arrived in correct causal order
			const claimIdx = events.findIndex((e) => e.type === "tenant.claimed");
			const releaseIdx = events.findIndex((e) => e.type === "tenant.released");
			expect(claimIdx).toBeLessThan(releaseIdx);

			// Step 8: Verify event payloads contain correct IDs
			expect(claimEvent!.workloadId).toBeDefined();
			expect(claimEvent!.source).toBeDefined();

			ws.close();
		}, timeouts.operation);
	});
}
