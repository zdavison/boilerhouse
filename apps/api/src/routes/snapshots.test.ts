import { describe, test, expect } from "bun:test";
import { createTestApp, apiRequest } from "../test-helpers";

describe("GET /api/v1/snapshots", () => {
	test("route is not mounted — returns 404", async () => {
		const { app } = createTestApp();
		const res = await apiRequest(app, "/api/v1/snapshots");

		expect(res.status).toBe(404);
	});
});
