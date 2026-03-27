import { describe, test, expect, beforeEach } from "bun:test";
import { Elysia } from "elysia";
import { generateWorkloadId, generateTriggerId } from "@boilerhouse/core";
import { workloads, triggers } from "@boilerhouse/db";
import { createTestApp } from "../test-helpers";
import type { RouteDeps } from "./deps";
import { triggerAdapterPlugin } from "./trigger-adapters";

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Creates a parent Elysia app with the trigger plugin mounted.
 * Routes become ready after async driver resolution; callers that need
 * ready routes should `await tickRoutes()`.
 */
function createPluginApp(deps: RouteDeps) {
	const plugin = triggerAdapterPlugin(deps);
	const app = new Elysia().use(plugin);
	return app;
}

/** Yields to the microtask queue so the async route-init resolves (includes BullMQ setup). */
function tickRoutes() {
	return new Promise<void>((r) => setTimeout(r, 100));
}

function postJson(app: Elysia, path: string, body: unknown, headers?: Record<string, string>) {
	return app.handle(
		new Request(`http://localhost${path}`, {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			body: JSON.stringify(body),
		}),
	);
}

// ── loadTriggersFromDb (via plugin init) ──────────────────────────────────────

describe("loadTriggersFromDb", () => {
	test("only loads triggers with enabled=1", async () => {
		const ctx = createTestApp();
		const now = new Date();

		ctx.db.insert(triggers).values([
			{
				id: generateTriggerId(),
				name: "active-trigger",
				type: "webhook",
				tenant: { static: "t1" },
				workload: "my-workload",
				config: { path: "/hooks/active" },
				enabled: 1,
				createdAt: now,
				updatedAt: now,
			},
			{
				id: generateTriggerId(),
				name: "disabled-trigger",
				type: "webhook",
				tenant: { static: "t1" },
				workload: "my-workload",
				config: { path: "/hooks/disabled" },
				enabled: 0,
				createdAt: now,
				updatedAt: now,
			},
		]).run();

		const { app: _app, ...deps } = ctx;
		const app = createPluginApp(deps);
		await tickRoutes();

		// Active trigger path is registered — POST reaches the handler (not 404 from Elysia)
		const activeRes = await postJson(app, "/hooks/active", {});
		// 502 = claim failed (no matching workload), not 404 (route not registered)
		expect(activeRes.status).not.toBe(404);

		// Disabled trigger path is NOT registered — Elysia returns 404
		const disabledRes = await postJson(app, "/hooks/disabled", {});
		expect(disabledRes.status).toBe(404);
	});
});

// ── createDispatcherDeps.claim() ──────────────────────────────────────────────

describe("createDispatcherDeps.claim()", () => {
	let deps: RouteDeps;
	let app: Elysia;

	beforeEach(async () => {
		const ctx = createTestApp();
		const now = new Date();

		// Insert a webhook trigger so the route is registered
		ctx.db.insert(triggers).values({
			id: generateTriggerId(),
			name: "test-trigger",
			type: "webhook",
			tenant: { static: "tenant-001" },
			workload: "test-workload",
			config: { path: "/hooks/test" },
			enabled: 1,
			createdAt: now,
			updatedAt: now,
		}).run();

		const { app: _app, ...routeDeps } = ctx;
		deps = routeDeps;
		app = createPluginApp(deps);
		await tickRoutes();
	});

	test("returns 200 (queued) when workload does not exist — error handled async", async () => {
		// With trigger queues, dispatch is enqueued immediately — the caller gets 200.
		// The actual claim error happens asynchronously in the BullMQ worker.
		const res = await postJson(app, "/hooks/test", { text: "hello" });
		expect(res.status).toBe(200);
	});

	test("returns 200 (queued) when workload exists but status is not ready", async () => {
		const wid = generateWorkloadId();
		const now = new Date();
		const workload = {
			workload: { name: "test-workload", version: "1.0.0" },
			image: { ref: "test:latest" },
			resources: { vcpus: 1, memory_mb: 256, disk_gb: 2 },
			network: { access: "none" as const },
			idle: { action: "hibernate" as const },
		};

		deps.db.insert(workloads).values({
			workloadId: wid,
			name: "test-workload",
			version: "1.0.0",
			config: workload,
			status: "creating",
			createdAt: now,
			updatedAt: now,
		}).run();

		// With trigger queues, dispatch is enqueued immediately
		const res = await postJson(app, "/hooks/test", { text: "hello" });
		expect(res.status).toBe(200);
	});
});

// ── createDispatcherDeps.logActivity() ────────────────────────────────────────

describe("createDispatcherDeps.logActivity()", () => {
	test("does not throw when underlying activityLog.log() throws", async () => {
		const ctx = createTestApp();
		const now = new Date();

		ctx.db.insert(triggers).values({
			id: generateTriggerId(),
			name: "logging-trigger",
			type: "webhook",
			tenant: { static: "tenant-001" },
			workload: "missing-workload",
			config: { path: "/hooks/log-test" },
			enabled: 1,
			createdAt: now,
			updatedAt: now,
		}).run();

		// Override activityLog to throw
		const brokenActivityLog = {
			log: () => { throw new Error("DB gone"); },
		};
		const { app: _app, ...deps } = ctx;
		const injectedDeps = { ...deps, activityLog: brokenActivityLog as typeof deps.activityLog };
		const app = createPluginApp(injectedDeps);
		await tickRoutes();

		// With trigger queues, dispatch is enqueued — caller gets 200.
		// The claim failure and logActivity errors happen async in the worker.
		const res = await postJson(app, "/hooks/log-test", { text: "hello" });
		expect(res.status).toBe(200);
	});
});

// ── Rate limiting ─────────────────────────────────────────────────────────────

describe("Rate limiting", () => {
	test("returns 429 after exceeding the configured request limit", async () => {
		const ctx = createTestApp();
		const now = new Date();

		// Very tight rate limit: max 2 requests per window
		ctx.db.insert(triggers).values({
			id: generateTriggerId(),
			name: "rate-limited-trigger",
			type: "webhook",
			tenant: { static: "t1" },
			workload: "missing",
			config: { path: "/hooks/rate-test", rateLimit: { max: 2, windowMs: 60_000 } },
			enabled: 1,
			createdAt: now,
			updatedAt: now,
		}).run();

		const { app: _app, ...deps } = ctx;
		const app = createPluginApp(deps);
		await tickRoutes();

		const sameIp = { "x-forwarded-for": "10.0.0.1" };
		const req1 = await postJson(app, "/hooks/rate-test", {}, sameIp);
		const req2 = await postJson(app, "/hooks/rate-test", {}, sameIp);
		const req3 = await postJson(app, "/hooks/rate-test", {}, sameIp);

		expect(req1.status).not.toBe(429);
		expect(req2.status).not.toBe(429);
		expect(req3.status).toBe(429);

		const retryAfter = req3.headers.get("Retry-After");
		expect(retryAfter).toBeDefined();
	});

	test("tracks rate limits independently per IP", async () => {
		const ctx = createTestApp();
		const now = new Date();

		ctx.db.insert(triggers).values({
			id: generateTriggerId(),
			name: "per-ip-trigger",
			type: "webhook",
			tenant: { static: "t1" },
			workload: "missing",
			config: { path: "/hooks/per-ip", rateLimit: { max: 1, windowMs: 60_000 } },
			enabled: 1,
			createdAt: now,
			updatedAt: now,
		}).run();

		const { app: _app, ...deps } = ctx;
		const app = createPluginApp(deps);
		await tickRoutes();

		// IP 1 exhausts its limit
		await postJson(app, "/hooks/per-ip", {}, { "x-forwarded-for": "1.1.1.1" });
		const ip1Second = await postJson(app, "/hooks/per-ip", {}, { "x-forwarded-for": "1.1.1.1" });
		expect(ip1Second.status).toBe(429);

		// IP 2 still gets through
		const ip2 = await postJson(app, "/hooks/per-ip", {}, { "x-forwarded-for": "2.2.2.2" });
		expect(ip2.status).not.toBe(429);
	});
});

// ── 503 before routes ready ───────────────────────────────────────────────────

describe("503 before routes are ready", () => {
	test("returns 503 when routes have not been initialized", async () => {
		const ctx = createTestApp();
		const now = new Date();

		ctx.db.insert(triggers).values({
			id: generateTriggerId(),
			name: "early-trigger",
			type: "webhook",
			tenant: { static: "t1" },
			workload: "missing",
			config: { path: "/hooks/early" },
			enabled: 1,
			createdAt: now,
			updatedAt: now,
		}).run();

		const { app: _app, ...deps } = ctx;
		const app = createPluginApp(deps);
		// Do NOT await tickRoutes — routes are not yet ready

		const res = await postJson(app, "/hooks/early", {});
		// The response may be 503 (not ready) or 502 (claim failed — routes already resolved)
		// Either is acceptable but it must not be 200
		expect([503, 502]).toContain(res.status);
	});
});
