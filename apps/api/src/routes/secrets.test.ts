import { describe, test, expect } from "bun:test";
import { createTestApp, apiRequest } from "../test-helpers";

describe("secret routes", () => {
	test("PUT /tenants/:id/secrets/:name sets a secret (201)", async () => {
		const ctx = createTestApp();
		const res = await apiRequest(ctx.app, "/api/v1/tenants/00000000-0000-4000-8000-000000000001/secrets/API_KEY", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ value: "sk-tes00000000-0000-4000-8000-0000000000012345" }),
		});
		expect(res.status).toBe(201);
	});

	test("GET /tenants/:id/secrets lists names without values", async () => {
		const ctx = createTestApp();
		ctx.secretStore.set("00000000-0000-4000-8000-000000000001" as any, "KEY_A", "val-a");
		ctx.secretStore.set("00000000-0000-4000-8000-000000000001" as any, "KEY_B", "val-b");

		const res = await apiRequest(ctx.app, "/api/v1/tenants/00000000-0000-4000-8000-000000000001/secrets");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { secrets: string[] };
		expect(body.secrets).toEqual(["KEY_A", "KEY_B"]);
	});

	test("DELETE /tenants/:id/secrets/:name removes a secret", async () => {
		const ctx = createTestApp();
		ctx.secretStore.set("00000000-0000-4000-8000-000000000001" as any, "API_KEY", "value");

		const res = await apiRequest(ctx.app, "/api/v1/tenants/00000000-0000-4000-8000-000000000001/secrets/API_KEY", {
			method: "DELETE",
		});
		expect(res.status).toBe(200);
		expect(ctx.secretStore.get("00000000-0000-4000-8000-000000000001" as any, "API_KEY")).toBeNull();
	});

	test("rejects invalid secret names", async () => {
		const ctx = createTestApp();
		const res = await apiRequest(ctx.app, "/api/v1/tenants/00000000-0000-4000-8000-000000000001/secrets/.bad", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ value: "val" }),
		});
		expect(res.status).toBe(400);
	});
});
