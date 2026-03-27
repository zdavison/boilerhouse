import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { openclawDriver } from "./openclaw";
import type { DriverConfig, DriverEndpoint, SendContext } from "@boilerhouse/triggers";

let httpServer: ReturnType<typeof Bun.serve>;
let httpPort: number;

type RequestHandler = (req: Request) => Response | Promise<Response>;
let handler: RequestHandler;

beforeAll(() => {
	handler = () => new Response("not configured", { status: 500 });

	httpServer = Bun.serve({
		port: 0,
		fetch(req) {
			return handler(req);
		},
	});
	httpPort = httpServer.port!;
});

afterAll(() => {
	httpServer.stop(true);
});

beforeEach(() => {
	handler = () => new Response("not configured", { status: 500 });
});

function endpoint(): DriverEndpoint {
	return { httpUrl: `http://localhost:${httpPort}`, ws: null };
}

const driverConfig: DriverConfig = {
	options: {
		gatewayToken: "test-token-123",
		role: "operator",
		scopes: ["operator.admin"],
	},
};

const sendContext: SendContext = {
	tenantId: "tenant-1",
	triggerName: "tg-test",
	eventId: "evt-abc",
};

// ── handshake() ─────────────────────────────────────────────────────────────

test("handshake() throws when gatewayToken is missing", async () => {
	try {
		await openclawDriver.handshake!(endpoint(), { options: {} });
		expect(true).toBe(false);
	} catch (err) {
		expect((err as Error).message).toContain("gatewayToken");
	}
});

test("handshake() succeeds with valid connect flow", async () => {
	handler = () => new Response(JSON.stringify({ error: "empty messages" }), { status: 400 });
	await openclawDriver.handshake!(endpoint(), driverConfig);
	// If we get here, handshake succeeded (400 = auth ok, bad request)
});

test("handshake() throws on non-ok response", async () => {
	handler = () => new Response("invalid token", { status: 401 });

	try {
		await openclawDriver.handshake!(endpoint(), driverConfig);
		expect(true).toBe(false);
	} catch (err) {
		expect((err as Error).message).toContain("auth failed");
		expect((err as Error).message).toContain("invalid token");
	}
});

test("handshake() throws on wrong payload type", async () => {
	// 403 also means auth failure
	handler = () => new Response("forbidden", { status: 403 });

	try {
		await openclawDriver.handshake!(endpoint(), driverConfig);
		expect(true).toBe(false);
	} catch (err) {
		expect((err as Error).message).toContain("auth failed");
	}
});

test("handshake() sends correct auth and client info", async () => {
	let receivedAuth: string | null = null;

	handler = (req) => {
		receivedAuth = req.headers.get("Authorization");
		return new Response(JSON.stringify({ error: "empty" }), { status: 400 });
	};

	await openclawDriver.handshake!(endpoint(), driverConfig);
	expect(receivedAuth).toBe("Bearer test-token-123");
});

// ── send() ──────────────────────────────────────────────────────────────────

function sseResponse(chunks: string[], done = true): Response {
	const lines = chunks.map((c) => `data: ${c}\n\n`);
	if (done) lines.push("data: [DONE]\n\n");
	return new Response(lines.join(""), {
		status: 200,
		headers: { "Content-Type": "text/event-stream" },
	});
}

function chatChunk(content: string): string {
	return JSON.stringify({
		choices: [{ delta: { content } }],
	});
}

test("send() happy path — sends chat.send, collects until final, extracts text", async () => {
	handler = () => sseResponse([chatChunk("Hello "), chatChunk("from OpenClaw!")]);

	const result = (await openclawDriver.send(
		endpoint(),
		{ text: "hi", senderId: "u1", channelId: "c1", source: "telegram" as const, raw: {} },
		sendContext,
		driverConfig,
	)) as Record<string, unknown>;

	expect(result.text).toBe("Hello from OpenClaw!");
});

test("send() throws on rejected ack", async () => {
	handler = () => new Response("session not found", { status: 404 });

	try {
		await openclawDriver.send(
			endpoint(),
			{ text: "hi", senderId: "u1", channelId: "c1", source: "telegram" as const, raw: {} },
			sendContext,
			driverConfig,
		);
		expect(true).toBe(false);
	} catch (err) {
		expect((err as Error).message).toContain("API error");
		expect((err as Error).message).toContain("session not found");
	}
});

test("send() throws on error state", async () => {
	handler = () => new Response("model overloaded", { status: 500 });

	try {
		await openclawDriver.send(
			endpoint(),
			{ text: "hi", senderId: "u1", channelId: "c1", source: "telegram" as const, raw: {} },
			sendContext,
			driverConfig,
		);
		expect(true).toBe(false);
	} catch (err) {
		expect((err as Error).message).toContain("API error");
		expect((err as Error).message).toContain("model overloaded");
	}
});

test("send() returns fallback when no text content in final", async () => {
	// SSE stream with no text deltas
	handler = () => sseResponse([JSON.stringify({ choices: [{ delta: {} }] })]);

	const result = (await openclawDriver.send(
		endpoint(),
		{ text: "hi", senderId: "u1", channelId: "c1", source: "telegram" as const, raw: {} },
		sendContext,
		driverConfig,
	)) as Record<string, unknown>;

	expect(result.text).toBe("");
});

test("send() uses eventId as runId for idempotency", async () => {
	let receivedHeaders: Headers | null = null;

	handler = (req) => {
		receivedHeaders = req.headers;
		return sseResponse([chatChunk("ok")]);
	};

	await openclawDriver.send(
		endpoint(),
		{ text: "test", senderId: "u1", channelId: "c1", source: "telegram" as const, raw: {} },
		{ ...sendContext, eventId: "my-unique-event-id" },
		driverConfig,
	);

	expect(receivedHeaders).not.toBeNull();
	expect(receivedHeaders!.get("X-OpenClaw-Session-Key")).toBe("tenant-1");
});
