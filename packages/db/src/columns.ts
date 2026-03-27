import { integer } from "drizzle-orm/sqlite-core";
import { customType } from "drizzle-orm/sqlite-core";

/**
 * Custom integer column that maps `Date <-> integer` (milliseconds since epoch).
 *
 * Uses Drizzle's built-in `timestamp_ms` mode internally.
 *
 * @example
 * ```ts
 * const table = sqliteTable("t", {
 *   createdAt: timestamp("created_at").notNull(),
 * });
 * ```
 */
export function timestamp(name: string) {
	return integer(name, { mode: "timestamp_ms" });
}

/**
 * Custom text column that maps a typed object `T <-> JSON text`.
 *
 * Serializes to `JSON.stringify` on write, `JSON.parse` on read.
 *
 * @example
 * ```ts
 * const table = sqliteTable("t", {
 *   config: jsonObject<{ foo: string }>("config").notNull(),
 * });
 * ```
 */
export function jsonObject<T>(name: string) {
	return customType<{ data: T; driverData: string }>({
		dataType() {
			return "text";
		},
		toDriver(value: T): string {
			return JSON.stringify(value);
		},
		fromDriver(value: string): T {
			return JSON.parse(value) as T;
		},
	})(name);
}
