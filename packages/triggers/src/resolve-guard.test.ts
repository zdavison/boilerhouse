import { test, expect } from "bun:test";
import { resolveGuard, GuardResolveError } from "./resolve-guard";

test("returns null for undefined guardSpec", async () => {
	const result = await resolveGuard(undefined);
	expect(result).toBeNull();
});

test("throws GuardResolveError for non-existent module", async () => {
	try {
		await resolveGuard("./non-existent-guard.ts");
		expect(true).toBe(false);
	} catch (err) {
		expect(err).toBeInstanceOf(GuardResolveError);
	}
});

test("throws GuardResolveError if module has no check() export", async () => {
	// Create a temp file with no guard export
	const tmpPath = "/tmp/no-guard-export.ts";
	await Bun.write(tmpPath, "export const notAGuard = { foo: 'bar' };");

	try {
		await resolveGuard(tmpPath);
		expect(true).toBe(false);
	} catch (err) {
		expect(err).toBeInstanceOf(GuardResolveError);
		expect((err as GuardResolveError).message).toContain("does not export a valid Guard");
	}
});

test("resolves guard from file with default export", async () => {
	const tmpPath = "/tmp/test-guard.ts";
	await Bun.write(tmpPath, `
		export default {
			async check(ctx) {
				return { ok: true };
			}
		};
	`);

	const guard = await resolveGuard(tmpPath);
	expect(guard).not.toBeNull();
	expect(typeof guard?.check).toBe("function");
});

test("resolves guard from file with named export", async () => {
	const tmpPath = "/tmp/test-guard-named.ts";
	await Bun.write(tmpPath, `
		export const myGuard = {
			async check(ctx) {
				return { ok: false, message: "denied" };
			}
		};
	`);

	const guard = await resolveGuard(tmpPath);
	expect(guard).not.toBeNull();
	const result = await guard!.check({
		tenantId: "t-1",
		payload: { text: "", senderId: "", channelId: "", source: "webhook", raw: {} },
		trigger: { name: "t", type: "webhook", tenant: { static: "t" }, workload: "w", config: { path: "/test" } },
		options: {},
	});
	expect(result).toEqual({ ok: false, message: "denied" });
});
