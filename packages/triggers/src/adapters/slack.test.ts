import { test, expect, beforeAll, afterAll } from "bun:test";
import { createSlackRoutes } from "./slack";
import { Dispatcher } from "../dispatcher";
import type { DispatcherDeps } from "../dispatcher";
import type { TriggerDefinition, SlackConfig } from "../config";
import type { DriverMap, Driver, DriverConfig } from "../driver";

let agentServer: ReturnType<typeof Bun.serve>;
const signingSecret = "slack-signing-secret";

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
			return Response.json({ text: "agent reply", received: body });
		},
	});
});

afterAll(() => {
	agentServer.stop(true);
});

function makeTrigger(): TriggerDefinition & { config: SlackConfig } {
	return {
		name: "slack-test",
		type: "slack",
		tenant: { fromField: "user", prefix: "slack-" },
		workload: "w-1",
		config: {
			signingSecret,
			eventTypes: ["app_mention", "message"],
			botToken: "xoxb-test-token",
		},
	};
}

async function signRequest(body: string, timestamp: string): Promise<string> {
	const baseString = `v0:${timestamp}:${body}`;
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(signingSecret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(baseString));
	return `v0=${Buffer.from(sig).toString("hex")}`;
}

test("URL verification challenge response", async () => {
	const dispatcher = new Dispatcher(createTestDeps(), { waitForReady: false });
	const routes = createSlackRoutes([makeTrigger()], dispatcher);
	const handler = routes["/slack/events"]!;

	const body = JSON.stringify({
		type: "url_verification",
		challenge: "test-challenge-123",
	});

	const res = await handler(
		new Request("http://localhost/slack/events", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
		}),
	);

	expect(res.status).toBe(200);
	const json = await res.json() as Record<string, unknown>;
	expect(json.challenge).toBe("test-challenge-123");
});

test("event callback with valid signature dispatches with derived tenant", async () => {
	const dispatcher = new Dispatcher(createTestDeps(), { waitForReady: false });
	const routes = createSlackRoutes([makeTrigger()], dispatcher);
	const handler = routes["/slack/events"]!;

	const timestamp = Math.floor(Date.now() / 1000).toString();
	const body = JSON.stringify({
		type: "event_callback",
		event: {
			type: "app_mention",
			text: "hello bot",
			channel: "C123",
			user: "U456",
		},
	});
	const signature = await signRequest(body, timestamp);

	const res = await handler(
		new Request("http://localhost/slack/events", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Slack-Request-Timestamp": timestamp,
				"X-Slack-Signature": signature,
			},
			body,
		}),
	);

	expect(res.status).toBe(200);
});

test("event callback with invalid signature is rejected", async () => {
	const dispatcher = new Dispatcher(createTestDeps(), { waitForReady: false });
	const routes = createSlackRoutes([makeTrigger()], dispatcher);
	const handler = routes["/slack/events"]!;

	const body = JSON.stringify({
		type: "event_callback",
		event: { type: "app_mention", text: "hello", channel: "C123", user: "U456" },
	});

	const res = await handler(
		new Request("http://localhost/slack/events", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Slack-Request-Timestamp": "12345",
				"X-Slack-Signature": "v0=invalid",
			},
			body,
		}),
	);

	expect(res.status).toBe(401);
});

test("event callback with missing signature headers is rejected", async () => {
	const dispatcher = new Dispatcher(createTestDeps(), { waitForReady: false });
	const routes = createSlackRoutes([makeTrigger()], dispatcher);
	const handler = routes["/slack/events"]!;

	const body = JSON.stringify({
		type: "event_callback",
		event: { type: "app_mention", text: "hello", channel: "C123", user: "U456" },
	});

	const res = await handler(
		new Request("http://localhost/slack/events", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
		}),
	);

	expect(res.status).toBe(401);
});

test("non-matching event type returns 200 (ignored)", async () => {
	const dispatcher = new Dispatcher(createTestDeps(), { waitForReady: false });
	const routes = createSlackRoutes([makeTrigger()], dispatcher);
	const handler = routes["/slack/events"]!;

	const body = JSON.stringify({
		type: "event_callback",
		event: { type: "reaction_added", channel: "C123" },
	});

	const res = await handler(
		new Request("http://localhost/slack/events", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
		}),
	);

	expect(res.status).toBe(200);
});

test("empty triggers returns no routes", () => {
	const dispatcher = new Dispatcher(createTestDeps(), { waitForReady: false });
	const routes = createSlackRoutes([], dispatcher);
	expect(Object.keys(routes)).toHaveLength(0);
});

test("non-POST method returns 405", async () => {
	const dispatcher = new Dispatcher(createTestDeps(), { waitForReady: false });
	const routes = createSlackRoutes([makeTrigger()], dispatcher);
	const handler = routes["/slack/events"]!;

	const res = await handler(
		new Request("http://localhost/slack/events", { method: "GET" }),
	);

	expect(res.status).toBe(405);
});

test("invalid JSON returns 400", async () => {
	const dispatcher = new Dispatcher(createTestDeps(), { waitForReady: false });
	const routes = createSlackRoutes([makeTrigger()], dispatcher);
	const handler = routes["/slack/events"]!;

	const res = await handler(
		new Request("http://localhost/slack/events", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: "not json",
		}),
	);

	expect(res.status).toBe(400);
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
		["slack-test", { driver: mockDriver, driverConfig }],
	]);

	const dispatcher = new Dispatcher(createTestDeps(), { waitForReady: false });
	const routes = createSlackRoutes([makeTrigger()], dispatcher, driverMap);
	const handler = routes["/slack/events"]!;

	const timestamp = Math.floor(Date.now() / 1000).toString();
	const body = JSON.stringify({
		type: "event_callback",
		event: {
			type: "app_mention",
			text: "hello",
			channel: "C123",
			user: "U456",
		},
	});
	const signature = await signRequest(body, timestamp);

	const res = await handler(
		new Request("http://localhost/slack/events", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Slack-Request-Timestamp": timestamp,
				"X-Slack-Signature": signature,
			},
			body,
		}),
	);

	expect(res.status).toBe(200);
});

test("missing event in event_callback returns 400", async () => {
	const dispatcher = new Dispatcher(createTestDeps(), { waitForReady: false });
	const routes = createSlackRoutes([makeTrigger()], dispatcher);
	const handler = routes["/slack/events"]!;

	const body = JSON.stringify({
		type: "event_callback",
		// no event field
	});

	const res = await handler(
		new Request("http://localhost/slack/events", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body,
		}),
	);

	expect(res.status).toBe(400);
});
