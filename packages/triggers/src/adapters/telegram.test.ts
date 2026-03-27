import { test, expect, beforeAll, afterAll } from "bun:test";
import { createTelegramRoutes } from "./telegram";
import { Dispatcher } from "../dispatcher";
import type { DispatcherDeps } from "../dispatcher";
import type { TriggerDefinition, TelegramConfig } from "../config";
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
			return Response.json({ text: "bot reply", received: body });
		},
	});
});

afterAll(() => {
	agentServer.stop(true);
});

function makeTrigger(overrides?: Partial<TelegramConfig>): TriggerDefinition & { config: TelegramConfig } {
	return {
		name: "tg-test",
		type: "telegram",
		tenant: { fromField: "chatId", prefix: "tg-" },
		workload: "w-1",
		config: {
			botToken: "123456:ABC-test-token",
			secretToken: "my-secret",
			updateTypes: ["message"],
			...overrides,
		},
	};
}

test("valid message update dispatches with derived tenant", async () => {
	const dispatcher = new Dispatcher(createTestDeps(), { waitForReady: false });
	const routes = createTelegramRoutes([makeTrigger()], dispatcher);
	const handler = routes["/telegram/tg-test"]!;

	const res = await handler(
		new Request("http://localhost/telegram/tg-test", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Telegram-Bot-Api-Secret-Token": "my-secret",
			},
			body: JSON.stringify({
				update_id: 1,
				message: {
					message_id: 1,
					text: "hello bot",
					chat: { id: 12345 },
					from: { id: 1, first_name: "Test" },
				},
			}),
		}),
	);

	expect(res.status).toBe(200);
});

test("invalid secret token is rejected", async () => {
	const dispatcher = new Dispatcher(createTestDeps(), { waitForReady: false });
	const routes = createTelegramRoutes([makeTrigger()], dispatcher);
	const handler = routes["/telegram/tg-test"]!;

	const res = await handler(
		new Request("http://localhost/telegram/tg-test", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Telegram-Bot-Api-Secret-Token": "wrong-secret",
			},
			body: JSON.stringify({
				update_id: 1,
				message: { text: "hello", chat: { id: 1 } },
			}),
		}),
	);

	expect(res.status).toBe(401);
});

test("missing secret token is rejected when configured", async () => {
	const dispatcher = new Dispatcher(createTestDeps(), { waitForReady: false });
	const routes = createTelegramRoutes([makeTrigger()], dispatcher);
	const handler = routes["/telegram/tg-test"]!;

	const res = await handler(
		new Request("http://localhost/telegram/tg-test", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				update_id: 1,
				message: { text: "hello", chat: { id: 1 } },
			}),
		}),
	);

	expect(res.status).toBe(401);
});

test("no secret token config allows all requests", async () => {
	const dispatcher = new Dispatcher(createTestDeps(), { waitForReady: false });
	const routes = createTelegramRoutes(
		[makeTrigger({ secretToken: undefined })],
		dispatcher,
	);
	const handler = routes["/telegram/tg-test"]!;

	const res = await handler(
		new Request("http://localhost/telegram/tg-test", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				update_id: 1,
				message: { text: "hello", chat: { id: 1 }, from: { id: 99 } },
			}),
		}),
	);

	expect(res.status).toBe(200);
});

test("non-matching update type is ignored", async () => {
	const dispatcher = new Dispatcher(createTestDeps(), { waitForReady: false });
	const routes = createTelegramRoutes(
		[makeTrigger({ updateTypes: ["callback_query"] })],
		dispatcher,
	);
	const handler = routes["/telegram/tg-test"]!;

	const res = await handler(
		new Request("http://localhost/telegram/tg-test", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Telegram-Bot-Api-Secret-Token": "my-secret",
			},
			body: JSON.stringify({
				update_id: 1,
				message: { text: "hello", chat: { id: 1 } },
			}),
		}),
	);

	// Message update doesn't match callback_query filter
	expect(res.status).toBe(200);
});

test("each trigger gets its own route", () => {
	const dispatcher = new Dispatcher(createTestDeps(), { waitForReady: false });
	const routes = createTelegramRoutes(
		[
			makeTrigger(),
			{ ...makeTrigger(), name: "tg-other" },
		],
		dispatcher,
	);

	expect(routes["/telegram/tg-test"]).toBeDefined();
	expect(routes["/telegram/tg-other"]).toBeDefined();
});

test("non-POST method returns 405", async () => {
	const dispatcher = new Dispatcher(createTestDeps(), { waitForReady: false });
	const routes = createTelegramRoutes([makeTrigger()], dispatcher);
	const handler = routes["/telegram/tg-test"]!;

	const res = await handler(
		new Request("http://localhost/telegram/tg-test", { method: "GET" }),
	);

	expect(res.status).toBe(405);
});

test("invalid JSON returns 400", async () => {
	const dispatcher = new Dispatcher(createTestDeps(), { waitForReady: false });
	const routes = createTelegramRoutes([makeTrigger()], dispatcher);
	const handler = routes["/telegram/tg-test"]!;

	const res = await handler(
		new Request("http://localhost/telegram/tg-test", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Telegram-Bot-Api-Secret-Token": "my-secret",
			},
			body: "not json",
		}),
	);

	expect(res.status).toBe(400);
});

test("callback_query update dispatches correctly", async () => {
	const dispatcher = new Dispatcher(createTestDeps(), { waitForReady: false });
	const routes = createTelegramRoutes(
		[makeTrigger({ updateTypes: ["callback_query"] })],
		dispatcher,
	);
	const handler = routes["/telegram/tg-test"]!;

	const res = await handler(
		new Request("http://localhost/telegram/tg-test", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Telegram-Bot-Api-Secret-Token": "my-secret",
			},
			body: JSON.stringify({
				update_id: 2,
				callback_query: {
					id: "cb-1",
					data: "button_clicked",
					from: { id: 42 },
					message: { chat: { id: 99 } },
				},
			}),
		}),
	);

	expect(res.status).toBe(200);
});

test("sender name extraction — first_name + last_name", async () => {
	let dispatchedPayload: unknown = null;
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
	const routes = createTelegramRoutes([makeTrigger()], dispatcher);
	const handler = routes["/telegram/tg-test"]!;

	await handler(
		new Request("http://localhost/telegram/tg-test", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Telegram-Bot-Api-Secret-Token": "my-secret",
			},
			body: JSON.stringify({
				update_id: 3,
				message: {
					text: "hello",
					chat: { id: 123 },
					from: { id: 1, first_name: "John", last_name: "Doe", username: "johndoe" },
				},
			}),
		}),
	);

	const payload = dispatchedPayload as Record<string, unknown>;
	expect(payload.senderName).toBe("John Doe");
	expect(payload.source).toBe("telegram");

	captureServer.stop(true);
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
		["tg-test", { driver: mockDriver, driverConfig }],
	]);

	const dispatcher = new Dispatcher(createTestDeps(), { waitForReady: false });
	const routes = createTelegramRoutes([makeTrigger()], dispatcher, driverMap);
	const handler = routes["/telegram/tg-test"]!;

	const res = await handler(
		new Request("http://localhost/telegram/tg-test", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-Telegram-Bot-Api-Secret-Token": "my-secret",
			},
			body: JSON.stringify({
				update_id: 4,
				message: {
					text: "hello",
					chat: { id: 1 },
					from: { id: 1 },
				},
			}),
		}),
	);

	expect(res.status).toBe(200);
});
