import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { SessionManager, SessionError } from "./session-manager";
import type { Driver } from "./driver";

let wsServer: ReturnType<typeof Bun.serve>;
let wsPort: number;

// Configurable server behavior
let serverHandler: (ws: { send: (msg: string) => void }, message: string) => void;

beforeAll(() => {
	serverHandler = (ws, message) => {
		// Default: echo back
		ws.send(message);
	};

	wsServer = Bun.serve({
		port: 0,
		fetch(req, server) {
			const url = new URL(req.url);
			if (url.pathname === "/ws") {
				const upgraded = server.upgrade(req, { data: {} });
				if (!upgraded) {
					return new Response("Upgrade failed", { status: 400 });
				}
				return undefined as unknown as Response;
			}
			return new Response("Not Found", { status: 404 });
		},
		websocket: {
			message(ws, message) {
				serverHandler(ws as unknown as { send: (msg: string) => void }, String(message));
			},
		},
	});
	wsPort = wsServer.port!;
});

afterAll(() => {
	wsServer.stop(true);
});

beforeEach(() => {
	// Reset to echo behavior
	serverHandler = (ws, message) => {
		ws.send(message);
	};
});

test("send and receive a single message", async () => {
	const sm = new SessionManager();
	try {
		const response = await sm.send(
			"tenant-1",
			{ host: "localhost", port: wsPort },
			"/ws",
			{ text: "hello" },
		);
		expect(response).toEqual({ text: "hello" });
		expect(sm.size).toBe(1);
	} finally {
		sm.closeAll();
	}
});

test("reuses existing session for same tenant", async () => {
	const sm = new SessionManager();
	try {
		await sm.send("tenant-1", { host: "localhost", port: wsPort }, "/ws", { msg: 1 });
		await sm.send("tenant-1", { host: "localhost", port: wsPort }, "/ws", { msg: 2 });
		// Still only one session
		expect(sm.size).toBe(1);
	} finally {
		sm.closeAll();
	}
});

test("different tenants get different sessions", async () => {
	const sm = new SessionManager();
	try {
		await sm.send("tenant-a", { host: "localhost", port: wsPort }, "/ws", { t: "a" });
		await sm.send("tenant-b", { host: "localhost", port: wsPort }, "/ws", { t: "b" });
		expect(sm.size).toBe(2);
	} finally {
		sm.closeAll();
	}
});

test("queues messages when one is in-flight", async () => {
	let messageCount = 0;

	serverHandler = (ws, message) => {
		messageCount++;
		const parsed = JSON.parse(message);
		// Delay response slightly to ensure queuing
		setTimeout(() => {
			ws.send(JSON.stringify({ echo: parsed, seq: messageCount }));
		}, 10);
	};

	const sm = new SessionManager();
	try {
		// Send multiple messages concurrently
		const [r1, r2, r3] = await Promise.all([
			sm.send("tenant-q", { host: "localhost", port: wsPort }, "/ws", { n: 1 }),
			sm.send("tenant-q", { host: "localhost", port: wsPort }, "/ws", { n: 2 }),
			sm.send("tenant-q", { host: "localhost", port: wsPort }, "/ws", { n: 3 }),
		]);

		// All messages should have been processed sequentially
		expect((r1 as Record<string, unknown>).seq).toBe(1);
		expect((r2 as Record<string, unknown>).seq).toBe(2);
		expect((r3 as Record<string, unknown>).seq).toBe(3);
	} finally {
		sm.closeAll();
	}
});

test("remove closes session", async () => {
	const sm = new SessionManager();
	try {
		await sm.send("tenant-r", { host: "localhost", port: wsPort }, "/ws", { x: 1 });
		expect(sm.size).toBe(1);
		sm.remove("tenant-r");
		expect(sm.size).toBe(0);
	} finally {
		sm.closeAll();
	}
});

test("closeAll removes all sessions", async () => {
	const sm = new SessionManager();
	await sm.send("t1", { host: "localhost", port: wsPort }, "/ws", {});
	await sm.send("t2", { host: "localhost", port: wsPort }, "/ws", {});
	expect(sm.size).toBe(2);
	sm.closeAll();
	expect(sm.size).toBe(0);
});

test("reconnects if endpoint changes", async () => {
	const sm = new SessionManager();
	try {
		await sm.send("tenant-ec", { host: "localhost", port: wsPort }, "/ws", { v: 1 });
		expect(sm.size).toBe(1);

		// Same tenant, different path — should create new session
		await sm.send("tenant-ec", { host: "localhost", port: wsPort }, "/ws", { v: 2 });
		expect(sm.size).toBe(1);
	} finally {
		sm.closeAll();
	}
});

test("connection failure throws SessionError", async () => {
	const sm = new SessionManager();
	let caught: unknown;
	try {
		await sm.send(
			"tenant-fail",
			{ host: "localhost", port: 59999 }, // nothing listening
			"/ws",
			{},
		);
	} catch (err) {
		caught = err;
	} finally {
		sm.closeAll();
	}
	expect(caught).toBeDefined();
	expect(caught).toBeInstanceOf(SessionError);
});

test("response timeout rejects with error", async () => {
	serverHandler = () => {
		// Don't respond — let it timeout
	};

	// Use a driver with a short expect timeout
	const shortTimeoutDriver: Driver = {
		async send(endpoint, payload) {
			endpoint.ws!.send(payload);
			return endpoint.ws!.expect(undefined, 100);
		},
	};

	const sm = new SessionManager();
	try {
		await sm.send("tenant-to", { host: "localhost", port: wsPort }, "/ws", {}, {
			driver: shortTimeoutDriver,
		});
		expect(true).toBe(false);
	} catch (err) {
		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toContain("timed out");
	} finally {
		sm.closeAll();
	}
});

test("handles non-JSON response as raw string", async () => {
	serverHandler = (ws) => {
		ws.send("plain text response");
	};

	const sm = new SessionManager();
	try {
		const response = await sm.send("tenant-raw", { host: "localhost", port: wsPort }, "/ws", {});
		expect(response).toBe("plain text response");
	} finally {
		sm.closeAll();
	}
});

// ── Driver integration tests ────────────────────────────────────────────────

test("custom driver send() is used instead of default", async () => {
	let driverSendCalled = false;

	const customDriver: Driver = {
		async send(endpoint, payload) {
			driverSendCalled = true;
			endpoint.ws!.send({ wrapped: payload });
			const response = await endpoint.ws!.expect();
			return { driverProcessed: true, response };
		},
	};

	serverHandler = (ws, message) => {
		ws.send(message);
	};

	const sm = new SessionManager();
	try {
		const response = await sm.send(
			"tenant-drv",
			{ host: "localhost", port: wsPort },
			"/ws",
			{ text: "hello" },
			{ driver: customDriver },
		);

		expect(driverSendCalled).toBe(true);
		const r = response as Record<string, unknown>;
		expect(r.driverProcessed).toBe(true);
	} finally {
		sm.closeAll();
	}
});

test("custom driver handshake() is called on new session", async () => {
	let handshakeCalled = false;
	let handshakeConfig: unknown = null;

	const customDriver: Driver = {
		async handshake(_endpoint, config) {
			handshakeCalled = true;
			handshakeConfig = config;
		},
		async send(endpoint, payload) {
			endpoint.ws!.send(payload);
			return endpoint.ws!.expect();
		},
	};

	serverHandler = (ws, message) => {
		ws.send(message);
	};

	const sm = new SessionManager();
	try {
		await sm.send(
			"tenant-hs",
			{ host: "localhost", port: wsPort },
			"/ws",
			{ text: "hello" },
			{
				driver: customDriver,
				driverConfig: { options: { token: "abc" } },
			},
		);

		expect(handshakeCalled).toBe(true);
		expect((handshakeConfig as Record<string, unknown>).options).toEqual({ token: "abc" });
	} finally {
		sm.closeAll();
	}
});

test("handshake failure throws SessionError and tears down session", async () => {
	const failingDriver: Driver = {
		async handshake() {
			throw new Error("auth failed");
		},
		async send(endpoint, payload) {
			endpoint.ws!.send(payload);
			return endpoint.ws!.expect();
		},
	};

	const sm = new SessionManager();
	try {
		await sm.send(
			"tenant-hs-fail",
			{ host: "localhost", port: wsPort },
			"/ws",
			{ text: "hello" },
			{ driver: failingDriver },
		);
		expect(true).toBe(false);
	} catch (err) {
		expect(err).toBeInstanceOf(SessionError);
		expect((err as Error).message).toContain("handshake failed");
		expect((err as Error).message).toContain("auth failed");
	} finally {
		expect(sm.size).toBe(0);
		sm.closeAll();
	}
});

test("context is passed through to driver.send()", async () => {
	let receivedContext: unknown = null;

	const contextDriver: Driver = {
		async send(endpoint, payload, context) {
			receivedContext = context;
			endpoint.ws!.send(payload);
			return endpoint.ws!.expect();
		},
	};

	serverHandler = (ws, message) => {
		ws.send(message);
	};

	const sm = new SessionManager();
	try {
		await sm.send(
			"tenant-ctx",
			{ host: "localhost", port: wsPort },
			"/ws",
			{ text: "hello" },
			{
				driver: contextDriver,
				context: {
					tenantId: "tenant-ctx",
					triggerName: "my-trigger",
					eventId: "evt-123",
				},
			},
		);

		expect(receivedContext).not.toBeNull();
		const ctx = receivedContext as Record<string, unknown>;
		expect(ctx.tenantId).toBe("tenant-ctx");
		expect(ctx.triggerName).toBe("my-trigger");
		expect(ctx.eventId).toBe("evt-123");
	} finally {
		sm.closeAll();
	}
});

test("driverConfig is passed through to driver.handshake()", async () => {
	let receivedConfig: unknown = null;

	const configDriver: Driver = {
		async handshake(_endpoint, config) {
			receivedConfig = config;
		},
		async send(endpoint, payload) {
			endpoint.ws!.send(payload);
			return endpoint.ws!.expect();
		},
	};

	serverHandler = (ws, message) => {
		ws.send(message);
	};

	const sm = new SessionManager();
	try {
		await sm.send(
			"tenant-cfg",
			{ host: "localhost", port: wsPort },
			"/ws",
			{ text: "hello" },
			{
				driver: configDriver,
				driverConfig: {
					options: { gatewayToken: "secret-token", timeout: 5000 },
				},
			},
		);

		expect(receivedConfig).not.toBeNull();
		const cfg = receivedConfig as Record<string, unknown>;
		expect((cfg as { options: Record<string, unknown> }).options.gatewayToken).toBe("secret-token");
		expect((cfg as { options: Record<string, unknown> }).options.timeout).toBe(5000);
	} finally {
		sm.closeAll();
	}
});
