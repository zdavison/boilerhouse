import { Glob } from "bun";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { eq, and } from "drizzle-orm";
import { parseWorkload, generateWorkloadId } from "@boilerhouse/core";
import type { DrizzleDb } from "./database";
import { workloads } from "./schema";

export interface WorkloadLoaderResult {
	/** New workloads inserted. */
	loaded: number;
	/** Existing workloads whose config changed. */
	updated: number;
	/** Workloads already up-to-date. */
	unchanged: number;
	/** Files that failed to parse. */
	errors: Array<{ file: string; error: string }>;
}

/**
 * Scan a directory for `*.toml` files, parse each as a workload definition,
 * and upsert into the database.
 *
 * Matches on `(name, version)`. If the config has changed, updates it.
 * If it already matches, skips. Parse errors are collected without aborting.
 *
 * @param db - Drizzle database instance
 * @param dir - Path to the workloads directory
 */
export function loadWorkloadsFromDir(
	db: DrizzleDb,
	dir: string,
): WorkloadLoaderResult {
	const result: WorkloadLoaderResult = {
		loaded: 0,
		updated: 0,
		unchanged: 0,
		errors: [],
	};

	const glob = new Glob("**/*.toml");
	const files = Array.from(glob.scanSync({ cwd: dir }));

	for (const file of files) {
		const fullPath = join(dir, file);
		let content: string;
		try {
			content = readFileSync(fullPath, "utf-8");
		} catch (err) {
			result.errors.push({
				file,
				error: err instanceof Error ? err.message : String(err),
			});
			continue;
		}

		let workload;
		try {
			workload = parseWorkload(content);
		} catch (err) {
			result.errors.push({
				file,
				error: err instanceof Error ? err.message : String(err),
			});
			continue;
		}

		const { name, version } = workload.workload;

		const existing = db
			.select()
			.from(workloads)
			.where(and(eq(workloads.name, name), eq(workloads.version, version)))
			.get();

		if (!existing) {
			const now = new Date();
			db.insert(workloads)
				.values({
					workloadId: generateWorkloadId(),
					name,
					version,
					config: workload,
					status: "creating",
					createdAt: now,
					updatedAt: now,
				})
				.run();
			result.loaded++;
		} else {
			const configChanged =
				JSON.stringify(existing.config) !== JSON.stringify(workload);

			if (configChanged) {
				db.update(workloads)
					.set({ config: workload, updatedAt: new Date() })
					.where(eq(workloads.workloadId, existing.workloadId))
					.run();
				result.updated++;
			} else {
				result.unchanged++;
			}
		}
	}

	return result;
}
