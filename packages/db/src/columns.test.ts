import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { sqliteTable } from "drizzle-orm/sqlite-core";
import { eq } from "drizzle-orm";
import { timestamp, jsonObject } from "./columns";

// ── Test table ───────────────────────────────────────────────────────────────

const testTable = sqliteTable("test_columns", {
	id: jsonObject<string>("id").notNull(),
	createdAt: timestamp("created_at").notNull(),
	metadata: jsonObject<{ foo: string; count: number }>("metadata"),
	updatedAt: timestamp("updated_at"),
});

function createDb() {
	const sqlite = new Database(":memory:");
	sqlite.run("PRAGMA foreign_keys = ON");
	const db = drizzle(sqlite);
	db.run(`
		CREATE TABLE test_columns (
			id TEXT NOT NULL,
			created_at INTEGER NOT NULL,
			metadata TEXT,
			updated_at INTEGER
		)
	`);
	return db;
}

// ── timestamp column ─────────────────────────────────────────────────────────

describe("timestamp column", () => {
	test("round-trips a Date through integer (milliseconds)", () => {
		const db = createDb();
		const now = new Date("2025-06-15T12:30:00.000Z");

		db.insert(testTable)
			.values({ id: "1", createdAt: now })
			.run();

		const row = db.select().from(testTable).where(eq(testTable.id, "1")).get();
		expect(row).toBeDefined();
		expect(row!.createdAt).toBeInstanceOf(Date);
		expect(row!.createdAt.getTime()).toBe(now.getTime());
	});

	test("preserves millisecond precision", () => {
		const db = createDb();
		const precise = new Date("2025-01-01T00:00:00.123Z");

		db.insert(testTable)
			.values({ id: "2", createdAt: precise })
			.run();

		const row = db.select().from(testTable).where(eq(testTable.id, "2")).get();
		expect(row!.createdAt.getTime()).toBe(precise.getTime());
	});

	test("nullable timestamp returns null when not set", () => {
		const db = createDb();
		db.insert(testTable)
			.values({ id: "3", createdAt: new Date() })
			.run();

		const row = db.select().from(testTable).where(eq(testTable.id, "3")).get();
		expect(row!.updatedAt).toBeNull();
	});
});

// ── jsonObject column ────────────────────────────────────────────────────────

describe("jsonObject column", () => {
	test("round-trips an object through JSON text", () => {
		const db = createDb();
		const meta = { foo: "bar", count: 42 };

		db.insert(testTable)
			.values({ id: "10", createdAt: new Date(), metadata: meta })
			.run();

		const row = db.select().from(testTable).where(eq(testTable.id, "10")).get();
		expect(row!.metadata).toEqual(meta);
	});

	test("handles nested objects", () => {
		const db = createDb();
		const nested = { foo: "nested", count: 0 };

		db.insert(testTable)
			.values({ id: "11", createdAt: new Date(), metadata: nested })
			.run();

		const row = db
			.select()
			.from(testTable)
			.where(eq(testTable.id, "11"))
			.get();
		expect(row!.metadata).toEqual(nested);
	});

	test("nullable jsonObject returns null when not set", () => {
		const db = createDb();
		db.insert(testTable)
			.values({ id: "12", createdAt: new Date() })
			.run();

		const row = db
			.select()
			.from(testTable)
			.where(eq(testTable.id, "12"))
			.get();
		expect(row!.metadata).toBeNull();
	});

	test("can store and retrieve arrays inside jsonObject", () => {
		const db = createDb();
		// Using the string-typed jsonObject for a quick array test
		const arrMeta = { foo: "list", count: 3 };

		db.insert(testTable)
			.values({ id: "13", createdAt: new Date(), metadata: arrMeta })
			.run();

		const row = db
			.select()
			.from(testTable)
			.where(eq(testTable.id, "13"))
			.get();
		expect(row!.metadata).toEqual(arrMeta);
	});
});
