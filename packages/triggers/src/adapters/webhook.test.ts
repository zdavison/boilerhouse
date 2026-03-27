import { test, expect, beforeAll, afterAll } from "bun:test";
import { createWebhookRoutes } from "./webhook";
import { Dispatcher } from "../dispatcher";
import type { DispatcherDeps } from "../dispatcher";
import type { TriggerDefinition, WebhookConfig } from "../config";
import type { DriverMap, Driver, DriverConfig } from "../driver";

let agentServer: ReturnType<typeof Bun.serve>;

function createTestDeps(): DispatcherDeps {
	return {
		async claim(tenantId) {
			return {
				tenantId,
				instanceId: "i-1",
				endpoint: { host: "localhost", ports: [agentServer.port!] },
				source: "warm",
				latencyMs: 10,
			};
		},
		logActivity() {},
	};
}

beforeAll(() => {
	agentServer = Bun.serve({
		port: 0,
		async fetch(req) {
			const body = await req.json();
			return Response.json({ reply: "ok", received: body });
		},
	});
});

afterAll(() => {
	agentServer.stop(true);
});

function makeTrigger(config: WebhookConfig): TriggerDefinition & { config: WebhookConfig } {
	return {
		name: "test-hook",
		type: "webhook",
		tenant: { static: "t-1" },
		workload: "w-1",
		config,
	};
}

test("payload passthrough with static tenant", async () => {
	const dispatcher = new Dispatcher(createTestDeps(), { waitForReady: false });
	const routes = createWebhookRoutes(
		[makeTrigger({ path: "/hooks/test" })],
		dispatcher,
	);

	const handler = routes["/hooks/test"]!;
	const res = await handler(
		new Request("http://localhost/hooks/test", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ message: "hello" }),
		}),
	);

	expect(res.status).toBe(200);
	const body = await res.json() as Record<string, unknown>;
	expect(body.reply).toBe("ok");
});

test("tenant resolved from body field", async () => {
	const dispatcher = new Dispatcher(createTestDeps(), { waitForReady: false });
	const trigger: TriggerDefinition & { config: WebhookConfig } = {
		name: "dynamic-hook",
		type: "webhook",
		tenant: { fromField: "tenantId", prefix: "wh-" },
		workload: "w-1",
		config: { path: "/hooks/dynamic" },
	};
	const routes = createWebhookRoutes([trigger], dispatcher);

	const handler = routes["/hooks/dynamic"]!;
	const res = await handler(
		new Request("http://localhost/hooks/dynamic", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ tenantId: "user-42", data: "test" }),
		}),
	);

	expect(res.status).toBe(200);
});

test("tenant resolution failure returns 400", async () => {
	const dispatcher = new Dispatcher(createTestDeps(), { waitForReady: false });
	const trigger: TriggerDefinition & { config: WebhookConfig } = {
		name: "missing-field-hook",
		type: "webhook",
		tenant: { fromField: "userId" },
		workload: "w-1",
		config: { path: "/hooks/missing" },
	};
	const routes = createWebhookRoutes([trigger], dispatcher);

	const handler = routes["/hooks/missing"]!;
	const res = await handler(
		new Request("http://localhost/hooks/missing", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ data: "no userId field" }),
		}),
	);

	expect(res.status).toBe(400);
	const body = await res.json() as Record<string, unknown>;
	expect(body.error).toContain("userId");
});

test("HMAC validation - valid signature accepted", async () => {
	const secret = "test-secret-key";
	const payload = JSON.stringify({ data: "test" });

	// Compute valid HMAC
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
	const signature = `sha256=${Buffer.from(sig).toString("hex")}`;

	const dispatcher = new Dispatcher(createTestDeps(), { waitForReady: false });
	const routes = createWebhookRoutes(
		[makeTrigger({ path: "/hooks/secure", secret })],
		dispatcher,
	);

	const handler = routes["/hooks/secure"]!;
	const res = await handler(
		new Request("http://localhost/hooks/secure", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Signature-256": signature,
			},
			body: payload,
		}),
	);

	expect(res.status).toBe(200);
});

test("HMAC validation - invalid signature rejected", async () => {
	const dispatcher = new Dispatcher(createTestDeps(), { waitForReady: false });
	const routes = createWebhookRoutes(
		[makeTrigger({ path: "/hooks/secure", secret: "my-secret" })],
		dispatcher,
	);

	const handler = routes["/hooks/secure"]!;
	const res = await handler(
		new Request("http://localhost/hooks/secure", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Signature-256": "sha256=invalid",
			},
			body: JSON.stringify({ data: "test" }),
		}),
	);

	expect(res.status).toBe(401);
});

test("HMAC validation - missing signature rejected", async () => {
	const dispatcher = new Dispatcher(createTestDeps(), { waitForReady: false });
	const routes = createWebhookRoutes(
		[makeTrigger({ path: "/hooks/secure", secret: "my-secret" })],
		dispatcher,
	);

	const handler = routes["/hooks/secure"]!;
	const res = await handler(
		new Request("http://localhost/hooks/secure", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ data: "test" }),
		}),
	);

	expect(res.status).toBe(401);
});

test("multiple webhook triggers get separate routes", async () => {
	const dispatcher = new Dispatcher(createTestDeps(), { waitForReady: false });
	const routes = createWebhookRoutes(
		[
			makeTrigger({ path: "/hooks/a" }),
			{ ...makeTrigger({ path: "/hooks/b" }), name: "hook-b" },
		],
		dispatcher,
	);

	expect(routes["/hooks/a"]).toBeDefined();
	expect(routes["/hooks/b"]).toBeDefined();
});

test("non-POST method returns 405", async () => {
	const dispatcher = new Dispatcher(createTestDeps(), { waitForReady: false });
	const routes = createWebhookRoutes(
		[makeTrigger({ path: "/hooks/test" })],
		dispatcher,
	);

	const handler = routes["/hooks/test"]!;
	const res = await handler(
		new Request("http://localhost/hooks/test", { method: "GET" }),
	);

	expect(res.status).toBe(405);
});

test("invalid JSON body returns 400", async () => {
	const dispatcher = new Dispatcher(createTestDeps(), { waitForReady: false });
	const routes = createWebhookRoutes(
		[makeTrigger({ path: "/hooks/test" })],
		dispatcher,
	);

	const handler = routes["/hooks/test"]!;
	const res = await handler(
		new Request("http://localhost/hooks/test", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "not json {{{",
		}),
	);

	expect(res.status).toBe(400);
	const body = await res.json() as Record<string, unknown>;
	expect(body.error).toContain("Invalid JSON");
});

test("driver map is passed through to dispatcher", async () => {
	const mockDriver: Driver = {
		async send(endpoint, payload) {
			endpoint.ws!.send(payload);
			return endpoint.ws!.expect();
		},
	};
	const driverConfig: DriverConfig = { options: { key: "val" } };

	const driverMap: DriverMap = new Map([
		["test-hook", { driver: mockDriver, driverConfig }],
	]);

	const dispatcher = new Dispatcher(createTestDeps(), { waitForReady: false });
	const routes = createWebhookRoutes(
		[makeTrigger({ path: "/hooks/test" })],
		dispatcher,
		driverMap,
	);

	const handler = routes["/hooks/test"]!;
	// This should not throw — the driver is passed through but HTTP dispatch
	// is used since claim doesn't include websocket
	const res = await handler(
		new Request("http://localhost/hooks/test", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "hello" }),
		}),
	);

	expect(res.status).toBe(200);
});

test("builds TriggerPayload correctly from webhook body", async () => {
	let dispatchedPayload: unknown = null;
	const deps = createTestDeps();
	const origClaim = deps.claim;
	deps.claim = async (tenantId, workloadName) => {
		return origClaim(tenantId, workloadName);
	};

	// Override the agent server to capture the forwarded payload
	const captureServer = Bun.serve({
		port: 0,
		async fetch(req) {
			dispatchedPayload = await req.json();
			return Response.json({ ok: true });
		},
	});

	const captureDeps: DispatcherDeps = {
		async claim(tenantId) {
			return {
				tenantId,
				instanceId: "i-1",
				endpoint: { host: "localhost", ports: [captureServer.port!] },
				source: "warm",
				latencyMs: 10,
			};
		},
		logActivity() {},
	};

	const dispatcher = new Dispatcher(captureDeps, { waitForReady: false });
	const routes = createWebhookRoutes(
		[makeTrigger({ path: "/hooks/test" })],
		dispatcher,
	);

	const handler = routes["/hooks/test"]!;
	await handler(
		new Request("http://localhost/hooks/test", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "hello", senderId: "user-1", channelId: "ch-1" }),
		}),
	);

	const payload = dispatchedPayload as Record<string, unknown>;
	expect(payload.text).toBe("hello");
	expect(payload.senderId).toBe("user-1");
	expect(payload.channelId).toBe("ch-1");
	expect(payload.source).toBe("webhook");
	expect(payload.raw).toBeDefined();

	captureServer.stop(true);
});
