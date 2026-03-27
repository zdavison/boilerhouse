import { test, expect } from "bun:test";
import guard from "./index";
import type { GuardContext } from "@boilerhouse/triggers";

function makeCtx(senderId: string, options: Record<string, unknown> = {}): GuardContext {
	return {
		tenantId: `tg-${senderId}`,
		payload: {
			text: "hello",
			senderId,
			channelId: senderId,
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

test("allows sender in senderIds list", async () => {
	const result = await guard.check(makeCtx("123456789", {
		senderIds: ["123456789", "987654321"],
	}));
	expect(result).toEqual({ ok: true });
});

test("denies sender not in senderIds list", async () => {
	const result = await guard.check(makeCtx("999999999", {
		senderIds: ["123456789", "987654321"],
		denyMessage: "Not allowed.",
	}));
	expect(result).toEqual({ ok: false, message: "Not allowed." });
});

test("uses default denyMessage if not specified", async () => {
	const result = await guard.check(makeCtx("000", {
		senderIds: ["123"],
	}));
	expect(result.ok).toBe(false);
	expect((result as { ok: false; message: string }).message).toBeTruthy();
});

test("denies with misconfigured guard (missing senderIds)", async () => {
	const result = await guard.check(makeCtx("123", {}));
	expect(result.ok).toBe(false);
});
