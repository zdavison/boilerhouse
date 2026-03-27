import { test, expect } from "bun:test";
import { resolveTenantId, TenantResolutionError } from "./resolve-tenant";

test("static mapping returns the fixed value", () => {
	expect(resolveTenantId({ static: "my-tenant" }, {})).toBe("my-tenant");
});

test("static mapping ignores context", () => {
	expect(
		resolveTenantId({ static: "fixed" }, { user: "U123", channel: "C456" }),
	).toBe("fixed");
});

test("fromField extracts top-level field", () => {
	expect(
		resolveTenantId({ fromField: "user" }, { user: "U12345" }),
	).toBe("U12345");
});

test("fromField with prefix prepends to value", () => {
	expect(
		resolveTenantId(
			{ fromField: "user", prefix: "slack-" },
			{ user: "U12345" },
		),
	).toBe("slack-U12345");
});

test("fromField with dot-path extracts nested value", () => {
	expect(
		resolveTenantId(
			{ fromField: "message.chat.id", prefix: "tg-" },
			{ message: { chat: { id: 98765 } } },
		),
	).toBe("tg-98765");
});

test("fromField coerces numbers to string", () => {
	expect(
		resolveTenantId({ fromField: "chatId" }, { chatId: 12345 }),
	).toBe("12345");
});

test("fromField throws when field is missing", () => {
	expect(() =>
		resolveTenantId({ fromField: "user" }, { channel: "C123" }),
	).toThrow(TenantResolutionError);
});

test("fromField throws when nested path is missing", () => {
	expect(() =>
		resolveTenantId({ fromField: "a.b.c" }, { a: { x: 1 } }),
	).toThrow(TenantResolutionError);
});

test("fromField with empty prefix works like no prefix", () => {
	expect(
		resolveTenantId({ fromField: "id", prefix: "" }, { id: "abc" }),
	).toBe("abc");
});
