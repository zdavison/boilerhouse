import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { createTestDatabase, tenantSecrets } from "@boilerhouse/db";
import type { TenantId } from "@boilerhouse/core";
import { SecretStore } from "./secret-store";

function setup() {
	const db = createTestDatabase();
	const key = randomBytes(32).toString("hex");
	const store = new SecretStore(db, key);
	return { db, store };
}

const TENANT_A = "tenant-aaa" as TenantId;
const TENANT_B = "tenant-bbb" as TenantId;

describe("SecretStore", () => {
	test("set + get round-trips a secret", () => {
		const { store } = setup();
		store.set(TENANT_A, "API_KEY", "sk-test-12345");
		expect(store.get(TENANT_A, "API_KEY")).toBe("sk-test-12345");
	});

	test("get returns null for nonexistent secret", () => {
		const { store } = setup();
		expect(store.get(TENANT_A, "MISSING")).toBeNull();
	});

	test("set overwrites existing secret", () => {
		const { store } = setup();
		store.set(TENANT_A, "API_KEY", "old-value");
		store.set(TENANT_A, "API_KEY", "new-value");
		expect(store.get(TENANT_A, "API_KEY")).toBe("new-value");
	});

	test("list returns names without values", () => {
		const { store } = setup();
		store.set(TENANT_A, "KEY_A", "value-a");
		store.set(TENANT_A, "KEY_B", "value-b");
		const names = store.list(TENANT_A);
		expect(names).toEqual(["KEY_A", "KEY_B"]);
	});

	test("delete removes a secret", () => {
		const { store } = setup();
		store.set(TENANT_A, "API_KEY", "value");
		store.delete(TENANT_A, "API_KEY");
		expect(store.get(TENANT_A, "API_KEY")).toBeNull();
	});

	test("tenant isolation — different tenants same key name", () => {
		const { store } = setup();
		store.set(TENANT_A, "API_KEY", "value-a");
		store.set(TENANT_B, "API_KEY", "value-b");
		expect(store.get(TENANT_A, "API_KEY")).toBe("value-a");
		expect(store.get(TENANT_B, "API_KEY")).toBe("value-b");
	});

	test("encrypted values are not plaintext in DB", () => {
		const { db, store } = setup();
		store.set(TENANT_A, "API_KEY", "sk-secret-12345");
		const row = db
			.select()
			.from(tenantSecrets)
			.get();
		expect(row).not.toBeNull();
		expect(row!.encryptedValue).not.toBe("sk-secret-12345");
		expect(row!.encryptedValue).not.toContain("sk-secret-12345");
	});

	test("throws with invalid encryption key length", () => {
		const db = createTestDatabase();
		expect(() => new SecretStore(db, "tooshort")).toThrow(/32 bytes/);
	});

	test("resolveSecretRefs replaces ${tenant-secret:NAME} with actual values", () => {
		const { store } = setup();
		store.set(TENANT_A, "ANTHROPIC_API_KEY", "sk-ant-xxx");
		const result = store.resolveSecretRefs(
			TENANT_A,
			"Bearer ${tenant-secret:ANTHROPIC_API_KEY}",
		);
		expect(result).toBe("Bearer sk-ant-xxx");
	});

	test("resolveSecretRefs throws for missing tenant-secret", () => {
		const { store } = setup();
		expect(() =>
			store.resolveSecretRefs(TENANT_A, "${tenant-secret:MISSING_KEY}"),
		).toThrow(/MISSING_KEY/);
	});

	test("resolveSecretRefs replaces ${global-secret:NAME} from process.env", () => {
		const { store } = setup();
		const orig = process.env.TEST_GLOBAL_KEY;
		process.env.TEST_GLOBAL_KEY = "global-value-123";
		try {
			const result = store.resolveSecretRefs(
				TENANT_A,
				"Bearer ${global-secret:TEST_GLOBAL_KEY}",
			);
			expect(result).toBe("Bearer global-value-123");
		} finally {
			if (orig === undefined) delete process.env.TEST_GLOBAL_KEY;
			else process.env.TEST_GLOBAL_KEY = orig;
		}
	});

	test("resolveSecretRefs throws for missing global-secret", () => {
		const { store } = setup();
		expect(() =>
			store.resolveSecretRefs(TENANT_A, "${global-secret:NONEXISTENT_ENV_VAR_XYZ}"),
		).toThrow(/NONEXISTENT_ENV_VAR_XYZ/);
	});

	test("resolveSecretRefs handles mixed global and tenant secrets", () => {
		const { store } = setup();
		store.set(TENANT_A, "TENANT_KEY", "tenant-val");
		const orig = process.env.GLOBAL_KEY;
		process.env.GLOBAL_KEY = "global-val";
		try {
			const result = store.resolveSecretRefs(
				TENANT_A,
				"${global-secret:GLOBAL_KEY} ${tenant-secret:TENANT_KEY}",
			);
			expect(result).toBe("global-val tenant-val");
		} finally {
			if (orig === undefined) delete process.env.GLOBAL_KEY;
			else process.env.GLOBAL_KEY = orig;
		}
	});
});
