import { test, expect } from "bun:test";
import guard from "./index";
import type { GuardContext } from "@boilerhouse/triggers";

function makeCtx(tenantId: string, options: Record<string, unknown> = {}): GuardContext {
	return {
		tenantId,
		payload: {
			text: "hello",
			source: "telegram",
			raw: {},
		},
		trigger: {
			name: "test-trigger",
			type: "telegram-poll",
			tenant: { fromField: "username", prefix: "tg-" },
			workload: "my-workload",
			config: { botToken: "test" },
		},
		options,
	};
}

test("allows tenant in tenantIds list", async () => {
	const result = await guard.check(makeCtx("tg-thingsdoer", {
		tenantIds: ["tg-thingsdoer", "tg-alice"],
	}));
	expect(result).toEqual({ ok: true });
});

test("matches case-insensitively", async () => {
	const result = await guard.check(makeCtx("tg-ThingsDoer", {
		tenantIds: ["tg-thingsdoer"],
	}));
	expect(result).toEqual({ ok: true });
});

test("denies tenant not in tenantIds list", async () => {
	const result = await guard.check(makeCtx("tg-stranger", {
		tenantIds: ["tg-thingsdoer"],
		denyMessage: "Not allowed.",
	}));
	expect(result).toEqual({ ok: false, message: "Not allowed." });
});

test("uses default denyMessage if not specified", async () => {
	const result = await guard.check(makeCtx("tg-stranger", {
		tenantIds: ["tg-thingsdoer"],
	}));
	expect(result.ok).toBe(false);
	expect((result as { ok: false; message: string }).message).toBeTruthy();
});

test("denies with misconfigured guard (missing tenantIds)", async () => {
	const result = await guard.check(makeCtx("tg-anyone", {}));
	expect(result.ok).toBe(false);
});
