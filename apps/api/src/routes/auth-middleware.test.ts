import { describe, test, expect } from "bun:test";
import { createTestApp, apiRequest } from "../test-helpers";

const API_KEY = "test-secret-key";

// Routes that are intentionally exempt from API key auth.
// Keep this list minimal — it should only contain routes that are
// explicitly designed to be public (e.g. health probes).
const EXEMPT_PATHS = new Set(["/api/v1/health"]);

/**
 * Replace Elysia path parameters (:id, :name, etc.) with placeholder values
 * so we can make a real HTTP request against the route.
 */
function fillPathParams(path: string): string {
	return path.replace(/:([^/]+)/g, "00000000-0000-0000-0000-000000000000");
}

describe("API key authentication", () => {
	const ctx = createTestApp({ apiKey: API_KEY });

	const httpRoutes = ctx.app.routes.filter(
		(r) => r.method !== "WS" && r.method !== "SUBSCRIBE" && r.method !== "OPTIONS",
	);

	test("app has routes to test", () => {
		expect(httpRoutes.length).toBeGreaterThan(0);
	});

	describe("without API key", () => {
		for (const route of httpRoutes) {
			const path = fillPathParams(route.path);

			if (EXEMPT_PATHS.has(route.path)) {
				test(`${route.method} ${route.path} is publicly accessible`, async () => {
					const res = await apiRequest(ctx.app, path, { method: route.method });
					expect(res.status).not.toBe(401);
				});
			} else {
				test(`${route.method} ${route.path} returns 401`, async () => {
					const res = await apiRequest(ctx.app, path, { method: route.method });
					expect(res.status).toBe(401);
				});
			}
		}
	});

	// WebSocket auth uses ?token= query param checked via a guard in ws.ts.
	// Must send WebSocket upgrade headers to trigger the guard handler.
	const wsUpgradeHeaders = {
		Upgrade: "websocket",
		Connection: "Upgrade",
		"Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
		"Sec-WebSocket-Version": "13",
	};

	describe("WebSocket endpoint", () => {
		test("/ws without token returns 401", async () => {
			const res = await apiRequest(ctx.app, "/ws", { headers: wsUpgradeHeaders });
			expect(res.status).toBe(401);
		});

		test("/ws with wrong token returns 401", async () => {
			const res = await apiRequest(ctx.app, "/ws?token=wrong", { headers: wsUpgradeHeaders });
			expect(res.status).toBe(401);
		});

		test("/ws with valid token is accepted", async () => {
			const res = await apiRequest(ctx.app, `/ws?token=${API_KEY}`, { headers: wsUpgradeHeaders });
			expect(res.status).not.toBe(401);
		});
	});

	describe("with valid API key", () => {
		for (const route of httpRoutes) {
			const path = fillPathParams(route.path);
			test(`${route.method} ${route.path} is accepted`, async () => {
				const res = await apiRequest(ctx.app, path, {
					method: route.method,
					headers: { Authorization: `Bearer ${API_KEY}` },
				});
				expect(res.status).not.toBe(401);
			});
		}
	});

	describe("with wrong API key", () => {
		for (const route of httpRoutes) {
			const path = fillPathParams(route.path);

			if (EXEMPT_PATHS.has(route.path)) continue;

			test(`${route.method} ${route.path} returns 401`, async () => {
				const res = await apiRequest(ctx.app, path, {
					method: route.method,
					headers: { Authorization: "Bearer wrong-key" },
				});
				expect(res.status).toBe(401);
			});
		}
	});

	describe("when no API key is configured", () => {
		const openCtx = createTestApp();

		for (const route of openCtx.app.routes.filter(
			(r) => r.method !== "WS" && r.method !== "SUBSCRIBE" && r.method !== "OPTIONS",
		)) {
			const path = fillPathParams(route.path);
			test(`${route.method} ${route.path} is accessible without auth`, async () => {
				const res = await apiRequest(openCtx.app, path, { method: route.method });
				expect(res.status).not.toBe(401);
			});
		}
	});
});
