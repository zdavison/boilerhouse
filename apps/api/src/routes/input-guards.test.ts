import { describe, test, expect } from "bun:test";
import { createTestApp, apiRequest } from "../test-helpers";

describe("input-guards middleware", () => {
	const ctx = createTestApp();

	test("rejects null byte in path param", async () => {
		const res = await apiRequest(ctx.app, "/api/v1/tenants/%00/claim", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ workload: "test" }),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toContain("invalid characters");
	});

	test("rejects whitespace-only param", async () => {
		const res = await apiRequest(ctx.app, "/api/v1/tenants/%20/claim", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ workload: "test" }),
		});
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toContain("must not be empty");
	});

	test("rejects path traversal in param", async () => {
		const res = await apiRequest(ctx.app, "/api/v1/workloads/..%2f..%2fetc%2fpasswd");
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toContain("invalid characters");
	});

	test("rejects control characters in param", async () => {
		const res = await apiRequest(ctx.app, "/api/v1/tenants/test%01injected/secrets");
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toContain("invalid characters");
	});

	test("rejects null byte in secret name param", async () => {
		const res = await apiRequest(
			ctx.app,
			"/api/v1/tenants/t1/secrets/test%00injected",
			{
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ value: "secret" }),
			},
		);
		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toContain("invalid characters");
	});

	test("allows valid params through", async () => {
		const res = await apiRequest(ctx.app, "/api/v1/tenants/valid-tenant-123");
		// 404 = passed the guard, tenant doesn't exist
		expect(res.status).toBe(404);
	});

	test("allows params with dots and hyphens", async () => {
		const res = await apiRequest(ctx.app, "/api/v1/workloads/my-app.v1");
		// 404 = passed the guard, workload doesn't exist
		expect(res.status).toBe(404);
	});

	test("rejects DEL character", async () => {
		const res = await apiRequest(ctx.app, "/api/v1/tenants/test%7fid");
		expect(res.status).toBe(400);
	});

	test("does not block routes without params", async () => {
		const res = await apiRequest(ctx.app, "/api/v1/workloads");
		expect(res.status).toBe(200);
	});
});
