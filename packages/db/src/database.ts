import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import * as schema from "./schema";

/** Drizzle database instance typed with the full schema. */
export type DrizzleDb = BunSQLiteDatabase<typeof schema>;

/**
 * Opens (or creates) a SQLite database at `path`, applies PRAGMAs,
 * runs all pending migrations, and returns a typed Drizzle instance.
 *
 * @param path - File path for the SQLite database.
 * @example
 * ```ts
 * const db = initDatabase("/var/lib/boilerhouse/data.db");
 * ```
 */
export function initDatabase(path: string): DrizzleDb {
	const sqlite = new Database(path, { create: true });
	sqlite.run("PRAGMA journal_mode = WAL");
	sqlite.run("PRAGMA foreign_keys = ON");

	const db = drizzle(sqlite, { schema });

	migrate(db, {
		migrationsFolder: new URL("../drizzle", import.meta.url).pathname,
	});

	return db;
}

/**
 * Creates an in-memory SQLite database with all tables applied via migrations.
 * Each call returns an independent database instance.
 *
 * Intended for tests only.
 */
export function createTestDatabase(): DrizzleDb {
	const sqlite = new Database(":memory:");
	sqlite.run("PRAGMA foreign_keys = ON");

	const db = drizzle(sqlite, { schema });

	migrate(db, {
		migrationsFolder: new URL("../drizzle", import.meta.url).pathname,
	});

	return db;
}
