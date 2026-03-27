import { Glob } from "bun";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { generateTriggerId } from "@boilerhouse/core";
import type { DrizzleDb } from "./database";
import { triggers } from "./schema";

/** Shape of a trigger definition file's default export. */
interface TriggerFileConfig {
	name: string;
	type: "webhook" | "slack" | "telegram" | "cron";
	tenant: { static: string } | { fromField: string; prefix?: string };
	workload: string;
	config: Record<string, unknown>;
	driver?: string;
	driverOptions?: Record<string, unknown>;
	guard?: string;
	guardOptions?: Record<string, unknown>;
}

export interface TriggerLoaderResult {
	/** New triggers inserted. */
	loaded: number;
	/** Existing triggers whose config changed. */
	updated: number;
	/** Triggers already up-to-date. */
	unchanged: number;
	/** Files that failed to parse. */
	errors: Array<{ file: string; error: string }>;
}

/**
 * Scan a directory for `*.trigger.ts` trigger definition files, dynamically
 * import each, and upsert into the database.
 *
 * Matches on `name`. If the config has changed, updates it.
 * If it already matches, skips. Import errors are collected without aborting.
 */
export async function loadTriggersFromDir(
	db: DrizzleDb,
	dir: string,
): Promise<TriggerLoaderResult> {
	const result: TriggerLoaderResult = {
		loaded: 0,
		updated: 0,
		unchanged: 0,
		errors: [],
	};

	const glob = new Glob("**/*.trigger.ts");
	const files = Array.from(glob.scanSync({ cwd: dir, followSymlinks: true }));

	for (const file of files) {
		const fullPath = resolve(dir, file);

		let mod: { default?: TriggerFileConfig };
		try {
			const mtime = Bun.file(fullPath).lastModified;
			mod = await import(`${fullPath}?v=${mtime}`);
		} catch (err) {
			result.errors.push({
				file,
				error: err instanceof Error ? err.message : String(err),
			});
			continue;
		}

		if (!mod.default) {
			result.errors.push({ file, error: "Module has no default export" });
			continue;
		}

		const def = mod.default;

		if (!def.name || !def.type || !def.workload || !def.config) {
			result.errors.push({
				file,
				error: "Trigger definition missing required fields (name, type, workload, config)",
			});
			continue;
		}

		const existing = db
			.select()
			.from(triggers)
			.where(eq(triggers.name, def.name))
			.get();

		const now = new Date();

		if (!existing) {
			db.insert(triggers)
				.values({
					id: generateTriggerId(),
					name: def.name,
					type: def.type,
					tenant: def.tenant,
					workload: def.workload,
					config: def.config,
					driver: def.driver ?? null,
					driverOptions: def.driverOptions ?? null,
					guard: def.guard ?? null,
					guardOptions: def.guardOptions ?? null,
					enabled: 1,
					createdAt: now,
					updatedAt: now,
				})
				.run();
			result.loaded++;
		} else {
			// Compare everything except id, enabled, timestamps
			const changed =
				existing.type !== def.type ||
				existing.workload !== def.workload ||
				existing.driver !== (def.driver ?? null) ||
				existing.guard !== (def.guard ?? null) ||
				JSON.stringify(existing.tenant) !== JSON.stringify(def.tenant) ||
				JSON.stringify(existing.config) !== JSON.stringify(def.config) ||
				JSON.stringify(existing.driverOptions) !== JSON.stringify(def.driverOptions ?? null) ||
				JSON.stringify(existing.guardOptions) !== JSON.stringify(def.guardOptions ?? null);

			if (changed) {
				db.update(triggers)
					.set({
						type: def.type,
						tenant: def.tenant,
						workload: def.workload,
						config: def.config,
						driver: def.driver ?? null,
						driverOptions: def.driverOptions ?? null,
						guard: def.guard ?? null,
						guardOptions: def.guardOptions ?? null,
						updatedAt: now,
					})
					.where(eq(triggers.id, existing.id))
					.run();
				result.updated++;
			} else {
				result.unchanged++;
			}
		}
	}

	return result;
}
