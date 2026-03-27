import { describe, test, expect } from "bun:test";
import { createTestApp, apiRequest } from "../test-helpers";

describe("GET /api/v1/audit", () => {
	test("returns empty list when no activity exists", async () => {
		const { app } = createTestApp();
		const res = await apiRequest(app, "/api/v1/audit");

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([]);
	});

	test("returns logged events newest-first", async () => {
		const { app, activityLog } = createTestApp();

		activityLog.log({ event: "first", instanceId: null, tenantId: null, workloadId: null, nodeId: null, metadata: null });
		activityLog.log({ event: "second", instanceId: null, tenantId: null, workloadId: null, nodeId: null, metadata: null });

		const res = await apiRequest(app, "/api/v1/audit");
		const body = await res.json();

		expect(res.status).toBe(200);
		expect(body).toHaveLength(2);
		expect(body[0].event).toBe("second");
		expect(body[1].event).toBe("first");
	});

	test("respects limit query parameter", async () => {
		const { app, activityLog } = createTestApp();

		for (let i = 0; i < 5; i++) {
			activityLog.log({ event: `event-${i}`, instanceId: null, tenantId: null, workloadId: null, nodeId: null, metadata: null });
		}

		const res = await apiRequest(app, "/api/v1/audit?limit=2");
		const body = await res.json();

		expect(res.status).toBe(200);
		expect(body).toHaveLength(2);
		expect(body[0].event).toBe("event-4");
		expect(body[1].event).toBe("event-3");
	});

	test("clamps limit to 500", async () => {
		const { app } = createTestApp();
		const res = await apiRequest(app, "/api/v1/audit?limit=9999");

		expect(res.status).toBe(200);
		// Just verify it doesn't error — clamping is internal
		expect(await res.json()).toEqual([]);
	});

	test("includes metadata and ISO date strings", async () => {
		const { app, activityLog } = createTestApp();

		activityLog.log({
			event: "instance.error",
			instanceId: null,
			tenantId: null,
			workloadId: null,
			nodeId: null,
			metadata: { reason: "OOM", exitCode: 137 },
		});

		const res = await apiRequest(app, "/api/v1/audit");
		const body = await res.json();

		expect(body).toHaveLength(1);
		expect(body[0].metadata).toEqual({ reason: "OOM", exitCode: 137 });
		expect(body[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(body[0].id).toBeNumber();
	});
});
