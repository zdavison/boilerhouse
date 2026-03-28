import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { createTestDatabase } from "./database";
import { triggers } from "./schema";
import { loadTriggersFromDir } from "./trigger-loader";
import type { DrizzleDb } from "./database";

const VALID_TRIGGER = `
export default {
	name: "tg-support",
	type: "telegram-poll",
	tenant: { fromField: "chatId", prefix: "tg-" },
	workload: "support-agent",
	config: {
		botToken: "123:ABC",
		updateTypes: ["message"],
	},
};
`;

const VALID_TRIGGER_2 = `
export default {
	name: "webhook-deploy",
	type: "webhook",
	tenant: { static: "deploy-bot" },
	workload: "deploy-agent",
	config: {
		path: "/hooks/deploy",
	},
};
`;

const TRIGGER_WITH_DRIVER = `
export default {
	name: "tg-openclaw",
	type: "telegram-poll",
	tenant: { fromField: "chatId", prefix: "oc-" },
	workload: "openclaw-agent",
	config: {
		botToken: "456:DEF",
		updateTypes: ["message"],
	},
	driver: "@boilerhouse/driver-openclaw",
	driverOptions: { gatewayToken: "gw-token-123" },
};
`;

const UPDATED_TRIGGER = `
export default {
	name: "tg-support",
	type: "telegram-poll",
	tenant: { fromField: "chatId", prefix: "tg-" },
	workload: "support-agent-v2",
	config: {
		botToken: "789:GHI",
		updateTypes: ["message", "callback_query"],
	},
};
`;

const NO_DEFAULT_EXPORT = `
export const notDefault = { name: "bad" };
`;

const MISSING_FIELDS = `
export default {
	name: "incomplete",
};
`;

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "trigger-loader-test-"));
}

function writeTs(dir: string, filename: string, content: string): void {
	writeFileSync(join(dir, filename), content);
}

describe("loadTriggersFromDir", () => {
	let db: DrizzleDb;

	beforeEach(() => {
		db = createTestDatabase();
	});

	test("loads new triggers into an empty database", async () => {
		const dir = makeTempDir();
		writeTs(dir, "support.trigger.ts", VALID_TRIGGER);
		writeTs(dir, "deploy.trigger.ts", VALID_TRIGGER_2);

		const result = await loadTriggersFromDir(db, dir);

		expect(result.loaded).toBe(2);
		expect(result.updated).toBe(0);
		expect(result.unchanged).toBe(0);
		expect(result.errors).toHaveLength(0);

		const rows = db.select().from(triggers).all();
		expect(rows).toHaveLength(2);

		const names = rows.map((r) => r.name).sort();
		expect(names).toEqual(["tg-support", "webhook-deploy"]);
	});

	test("skips unchanged triggers on second load", async () => {
		const dir = makeTempDir();
		writeTs(dir, "support.trigger.ts", VALID_TRIGGER);

		await loadTriggersFromDir(db, dir);
		const result = await loadTriggersFromDir(db, dir);

		expect(result.loaded).toBe(0);
		expect(result.updated).toBe(0);
		expect(result.unchanged).toBe(1);
		expect(result.errors).toHaveLength(0);
	});

	test("updates triggers when config changes", async () => {
		const dir = makeTempDir();
		writeTs(dir, "support.trigger.ts", VALID_TRIGGER);

		await loadTriggersFromDir(db, dir);

		writeTs(dir, "support.trigger.ts", UPDATED_TRIGGER);
		const future = new Date(Date.now() + 2000);
		utimesSync(join(dir, "support.trigger.ts"), future, future);

		const result = await loadTriggersFromDir(db, dir);

		expect(result.loaded).toBe(0);
		expect(result.updated).toBe(1);
		expect(result.unchanged).toBe(0);
		expect(result.errors).toHaveLength(0);

		const row = db
			.select()
			.from(triggers)
			.where(eq(triggers.name, "tg-support"))
			.get();

		expect(row).toBeTruthy();
		expect(row!.workload).toBe("support-agent-v2");
	});

	test("preserves trigger ID across updates", async () => {
		const dir = makeTempDir();
		writeTs(dir, "support.trigger.ts", VALID_TRIGGER);

		await loadTriggersFromDir(db, dir);
		const before = db
			.select()
			.from(triggers)
			.where(eq(triggers.name, "tg-support"))
			.get();

		writeTs(dir, "support.trigger.ts", UPDATED_TRIGGER);
		const future = new Date(Date.now() + 2000);
		utimesSync(join(dir, "support.trigger.ts"), future, future);
		await loadTriggersFromDir(db, dir);

		const after = db
			.select()
			.from(triggers)
			.where(eq(triggers.name, "tg-support"))
			.get();

		expect(after!.id).toBe(before!.id);
	});

	test("handles driver and driverOptions fields", async () => {
		const dir = makeTempDir();
		writeTs(dir, "oc.trigger.ts", TRIGGER_WITH_DRIVER);

		const result = await loadTriggersFromDir(db, dir);
		expect(result.loaded).toBe(1);

		const row = db
			.select()
			.from(triggers)
			.where(eq(triggers.name, "tg-openclaw"))
			.get();

		expect(row).toBeTruthy();
		expect(row!.driver).toBe("@boilerhouse/driver-openclaw");
		expect(row!.driverOptions).toEqual({ gatewayToken: "gw-token-123" });
	});

	test("driver field null when not specified", async () => {
		const dir = makeTempDir();
		writeTs(dir, "support.trigger.ts", VALID_TRIGGER);

		await loadTriggersFromDir(db, dir);

		const row = db
			.select()
			.from(triggers)
			.where(eq(triggers.name, "tg-support"))
			.get();

		expect(row!.driver).toBeNull();
		expect(row!.driverOptions).toBeNull();
	});

	test("detects driver field change as update", async () => {
		const dir = makeTempDir();
		writeTs(dir, "support.trigger.ts", VALID_TRIGGER);
		await loadTriggersFromDir(db, dir);

		// Add driver to existing trigger
		const withDriver = `
export default {
	name: "tg-support",
	type: "telegram-poll",
	tenant: { fromField: "chatId", prefix: "tg-" },
	workload: "support-agent",
	config: {
		botToken: "123:ABC",
		updateTypes: ["message"],
	},
	driver: "@boilerhouse/driver-openclaw",
	driverOptions: { gatewayToken: "token" },
};
`;
		writeTs(dir, "support.trigger.ts", withDriver);
		const future = new Date(Date.now() + 2000);
		utimesSync(join(dir, "support.trigger.ts"), future, future);

		const result = await loadTriggersFromDir(db, dir);
		expect(result.updated).toBe(1);

		const row = db
			.select()
			.from(triggers)
			.where(eq(triggers.name, "tg-support"))
			.get();

		expect(row!.driver).toBe("@boilerhouse/driver-openclaw");
	});

	test("missing default export adds to errors", async () => {
		const dir = makeTempDir();
		writeTs(dir, "bad.trigger.ts", NO_DEFAULT_EXPORT);

		const result = await loadTriggersFromDir(db, dir);

		expect(result.loaded).toBe(0);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]!.file).toContain("bad.trigger.ts");
		expect(result.errors[0]!.error).toContain("no default export");
	});

	test("missing required fields adds to errors", async () => {
		const dir = makeTempDir();
		writeTs(dir, "incomplete.trigger.ts", MISSING_FIELDS);

		const result = await loadTriggersFromDir(db, dir);

		expect(result.loaded).toBe(0);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]!.error).toContain("missing required fields");
	});

	test("import failure adds to errors without aborting", async () => {
		const dir = makeTempDir();
		writeTs(dir, "good.trigger.ts", VALID_TRIGGER);
		writeTs(dir, "syntax-error.trigger.ts", "export default {{{invalid syntax");

		const result = await loadTriggersFromDir(db, dir);

		expect(result.loaded).toBe(1);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]!.file).toContain("syntax-error.trigger.ts");
	});

	test("handles empty directory", async () => {
		const dir = makeTempDir();

		const result = await loadTriggersFromDir(db, dir);

		expect(result.loaded).toBe(0);
		expect(result.updated).toBe(0);
		expect(result.unchanged).toBe(0);
		expect(result.errors).toHaveLength(0);
	});

	test("enabled defaults to 1", async () => {
		const dir = makeTempDir();
		writeTs(dir, "support.trigger.ts", VALID_TRIGGER);

		await loadTriggersFromDir(db, dir);

		const row = db
			.select()
			.from(triggers)
			.where(eq(triggers.name, "tg-support"))
			.get();

		expect(row!.enabled).toBe(1);
	});
});
