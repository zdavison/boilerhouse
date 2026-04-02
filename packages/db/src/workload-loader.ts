import { Glob, plugin } from "bun";
import { resolve, isAbsolute } from "node:path";
import { eq, and } from "drizzle-orm";
import * as boilerhouseCore from "@boilerhouse/core";
import { resolveWorkloadConfig, generateWorkloadId } from "@boilerhouse/core";
import type { WorkloadConfig } from "@boilerhouse/core";
import type { DrizzleDb } from "./database";
import { workloads } from "./schema";

// Register @boilerhouse/core as a virtual module so dynamically-imported
// workload files can resolve it even in compiled binaries.
plugin({
	name: "boilerhouse-core-virtual",
	setup(build) {
		build.module("@boilerhouse/core", () => ({
			exports: boilerhouseCore,
			loader: "object",
		}));
	},
});

export interface WorkloadLoaderResult {
	/** New workloads inserted. */
	loaded: number;
	/** Existing workloads whose config changed. */
	updated: number;
	/** Workloads already up-to-date. */
	unchanged: number;
	/** Files that failed to parse. */
	errors: Array<{ file: string; error: string }>;
	/** IDs of newly inserted workloads. */
	newWorkloadIds: string[];
	/** IDs of workloads whose config was updated. */
	updatedWorkloadIds: string[];
}

/**
 * Scan a directory for `*.workload.ts` workload definition files, dynamically import
 * each, resolve through {@link resolveWorkloadConfig}, and upsert into the
 * database.
 *
 * Matches on `(name, version)`. If the config has changed, updates it.
 * If it already matches, skips. Import/validation errors are collected without
 * aborting.
 *
 * @param db - Drizzle database instance
 * @param dir - Path to the workloads directory
 */
export async function loadWorkloadsFromDir(
	db: DrizzleDb,
	dir: string,
): Promise<WorkloadLoaderResult> {
	const result: WorkloadLoaderResult = {
		loaded: 0,
		updated: 0,
		unchanged: 0,
		errors: [],
		newWorkloadIds: [],
		updatedWorkloadIds: [],
	};

	const glob = new Glob("**/*.workload.ts");
	const files = Array.from(glob.scanSync({ cwd: dir, followSymlinks: true }));

	for (const file of files) {

		const fullPath = resolve(dir, file);

		let mod: { default?: WorkloadConfig };
		try {
			// Cache-bust with mtime so re-imports pick up file changes
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
			result.errors.push({
				file,
				error: "Module has no default export",
			});
			continue;
		}

		let workload;
		try {
			workload = resolveWorkloadConfig(mod.default);
			if (workload.image.dockerfile && !isAbsolute(workload.image.dockerfile)) {
				workload = {
					...workload,
					image: { ...workload.image, dockerfile: resolve(dir, workload.image.dockerfile) },
				};
			}
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
			const workloadId = generateWorkloadId();
			db.insert(workloads)
				.values({
					workloadId,
					name,
					version,
					config: workload,
					status: "creating",
					createdAt: now,
					updatedAt: now,
				})
				.run();
			result.loaded++;
			result.newWorkloadIds.push(workloadId);
		} else {
			const configChanged =
				JSON.stringify(existing.config) !== JSON.stringify(workload);

			if (configChanged) {
				db.update(workloads)
					.set({ config: workload, updatedAt: new Date() })
					.where(eq(workloads.workloadId, existing.workloadId))
					.run();
				result.updated++;
				result.updatedWorkloadIds.push(existing.workloadId);
			} else {
				result.unchanged++;
			}
		}
	}

	return result;
}
