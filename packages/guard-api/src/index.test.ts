import { test, expect, beforeAll, afterAll } from "bun:test";
import guard from "./index";
import type { GuardContext } from "@boilerhouse/triggers";

let apiServer: ReturnType<typeof Bun.serve>;
let apiPort: number;

let apiResponse: { ok: boolean; message?: string } = { ok: true };
let apiShouldError = false;

beforeAll(() => {
	apiServer = Bun.serve({
		port: 0,
		async fetch(_req) {
			if (apiShouldError) {
				return new Response("error", { status: 500 });
			}
			return Response.json(apiResponse);
		},
	});
	apiPort = apiServer.port!;
});

afterAll(() => {
	apiServer.stop(true);
});

function makeCtx(options: Record<string, unknown> = {}): GuardContext {
	return {
		tenantId: "tg-123",
		payload: {
			text: "hello",
			senderId: "123456789",
			senderName: "Alice",
			channelId: "123456789",
			source: "telegram",
			raw: {},
		},
		trigger: {
			name: "test-trigger",
			type: "telegram-poll",
			tenant: { fromField: "chatId", prefix: "tg-" },
			workload: "my-workload",
			config: { botToken: "test" },
		},
		options,
	};
}

test("allows when API returns ok: true", async () => {
	apiResponse = { ok: true };
	apiShouldError = false;

	const result = await guard.check(makeCtx({
		url: `http://localhost:${apiPort}/check`,
	}));
	expect(result).toEqual({ ok: true });
});

test("denies with API message when API returns ok: false with message", async () => {
	apiResponse = { ok: false, message: "Your trial has expired." };
	apiShouldError = false;

	const result = await guard.check(makeCtx({
		url: `http://localhost:${apiPort}/check`,
		denyMessage: "fallback message",
	}));
	expect(result).toEqual({ ok: false, message: "Your trial has expired." });
});

test("uses fallback denyMessage when API returns ok: false without message", async () => {
	apiResponse = { ok: false };
	apiShouldError = false;

	const result = await guard.check(makeCtx({
		url: `http://localhost:${apiPort}/check`,
		denyMessage: "Sign up at https://myapp.com",
	}));
	expect(result).toEqual({ ok: false, message: "Sign up at https://myapp.com" });
});

test("fails closed on non-2xx response", async () => {
	apiShouldError = true;

	const result = await guard.check(makeCtx({
		url: `http://localhost:${apiPort}/check`,
		denyMessage: "Service unavailable.",
	}));
	expect(result).toEqual({ ok: false, message: "Service unavailable." });
});

test("fails closed on network error", async () => {
	const result = await guard.check(makeCtx({
		url: "http://localhost:1", // unreachable
		denyMessage: "Cannot connect.",
	}));
	expect(result).toEqual({ ok: false, message: "Cannot connect." });
});

test("returns misconfigured error when url is missing", async () => {
	const result = await guard.check(makeCtx({}));
	expect(result.ok).toBe(false);
});

test("forwards custom headers to API", async () => {
	let receivedAuth: string | null = null;

	const headerServer = Bun.serve({
		port: 0,
		async fetch(req) {
			receivedAuth = req.headers.get("Authorization");
			return Response.json({ ok: true });
		},
	});

	try {
		await guard.check(makeCtx({
			url: `http://localhost:${headerServer.port}/check`,
			headers: { Authorization: "Bearer mykey" },
		}));
		expect(receivedAuth).toBe("Bearer mykey");
	} finally {
		headerServer.stop(true);
	}
});
