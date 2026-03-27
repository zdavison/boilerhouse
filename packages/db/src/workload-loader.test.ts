import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq, and } from "drizzle-orm";
import { createTestDatabase } from "./database";
import { workloads } from "./schema";
import { loadWorkloadsFromDir } from "./workload-loader";
import type { DrizzleDb } from "./database";

// Test fixtures export plain config objects — defineWorkload() is an identity
// function so the loader only needs mod.default to be a WorkloadConfig shape.
// This avoids requiring @boilerhouse/core resolution from temp directories.

const VALID_TS = `
export default {
	name: "test-service",
	version: "1.0.0",
	image: { ref: "ghcr.io/test/service:latest" },
	resources: { vcpus: 1, memory_mb: 512 },
};
`;

const VALID_TS_2 = `
export default {
	name: "other-service",
	version: "2.0.0",
	image: { ref: "ghcr.io/test/other:latest" },
	resources: { vcpus: 2, memory_mb: 1024 },
};
`;

const UPDATED_TS = `
export default {
	name: "test-service",
	version: "1.0.0",
	image: { ref: "ghcr.io/test/service:latest" },
	resources: { vcpus: 4, memory_mb: 2048 },
};
`;

const INVALID_TS = `
export default {
	name: "broken",
	version: "1.0.0",
	image: {},
	resources: { vcpus: 1, memory_mb: 512 },
};
`;

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "workload-loader-test-"));
}

function writeTs(dir: string, filename: string, content: string): void {
	writeFileSync(join(dir, filename), content);
}

describe("loadWorkloadsFromDir", () => {
	let db: DrizzleDb;

	beforeEach(() => {
		db = createTestDatabase();
	});

	test("loads new workloads into an empty database", async () => {
		const dir = makeTempDir();
		writeTs(dir, "svc.workload.ts", VALID_TS);
		writeTs(dir, "other.workload.ts", VALID_TS_2);

		const result = await loadWorkloadsFromDir(db, dir);

		expect(result.loaded).toBe(2);
		expect(result.updated).toBe(0);
		expect(result.unchanged).toBe(0);
		expect(result.errors).toHaveLength(0);

		const rows = db.select().from(workloads).all();
		expect(rows).toHaveLength(2);

		const names = rows.map((r) => r.name).sort();
		expect(names).toEqual(["other-service", "test-service"]);
	});

	test("skips unchanged workloads on second load", async () => {
		const dir = makeTempDir();
		writeTs(dir, "svc.workload.ts", VALID_TS);

		await loadWorkloadsFromDir(db, dir);
		const result = await loadWorkloadsFromDir(db, dir);

		expect(result.loaded).toBe(0);
		expect(result.updated).toBe(0);
		expect(result.unchanged).toBe(1);
		expect(result.errors).toHaveLength(0);
	});

	test("updates workloads when config changes", async () => {
		const dir = makeTempDir();
		writeTs(dir, "svc.workload.ts", VALID_TS);

		await loadWorkloadsFromDir(db, dir);

		// Overwrite with changed config — bump mtime so Bun's import cache is busted
		// (without this, both writes can share the same mtime and Bun serves stale module)
		writeTs(dir, "svc.workload.ts", UPDATED_TS);
		const future = new Date(Date.now() + 2000);
		utimesSync(join(dir, "svc.workload.ts"), future, future);

		const result = await loadWorkloadsFromDir(db, dir);

		expect(result.loaded).toBe(0);
		expect(result.updated).toBe(1);
		expect(result.unchanged).toBe(0);
		expect(result.errors).toHaveLength(0);

		const row = db
			.select()
			.from(workloads)
			.where(
				and(
					eq(workloads.name, "test-service"),
					eq(workloads.version, "1.0.0"),
				),
			)
			.get();

		expect(row).toBeTruthy();
		expect(row!.config.resources.vcpus).toBe(4);
		expect(row!.config.resources.memory_mb).toBe(2048);
	});

	test("collects parse errors without aborting", async () => {
		const dir = makeTempDir();
		writeTs(dir, "good.workload.ts", VALID_TS);
		writeTs(dir, "bad.workload.ts", INVALID_TS);

		const result = await loadWorkloadsFromDir(db, dir);

		expect(result.loaded).toBe(1);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]!.file).toContain("bad.workload.ts");
		expect(result.errors[0]!.error).toBeTruthy();
	});

	test("handles empty directory", async () => {
		const dir = makeTempDir();

		const result = await loadWorkloadsFromDir(db, dir);

		expect(result.loaded).toBe(0);
		expect(result.updated).toBe(0);
		expect(result.unchanged).toBe(0);
		expect(result.errors).toHaveLength(0);
	});

	test("handles nested workload files", async () => {
		const dir = makeTempDir();
		mkdirSync(join(dir, "sub"));
		writeTs(dir, "sub/nested.workload.ts", VALID_TS);

		const result = await loadWorkloadsFromDir(db, dir);

		expect(result.loaded).toBe(1);
		expect(result.errors).toHaveLength(0);
	});

	test("resolves relative dockerfile path to absolute path based on workloads dir", async () => {
		const dir = makeTempDir();
		writeTs(
			dir,
			"svc.workload.ts",
			`
export default {
	name: "dockerfile-service",
	version: "1.0.0",
	image: { dockerfile: "svc/Dockerfile" },
	resources: { vcpus: 1, memory_mb: 512 },
};
`,
		);

		await loadWorkloadsFromDir(db, dir);

		const row = db
			.select()
			.from(workloads)
			.where(eq(workloads.name, "dockerfile-service"))
			.get();

		expect(row).toBeTruthy();
		expect(row!.config.image.dockerfile).toBe(join(dir, "svc/Dockerfile"));
	});

	test("preserves workloadId across updates", async () => {
		const dir = makeTempDir();
		writeTs(dir, "svc.workload.ts", VALID_TS);

		await loadWorkloadsFromDir(db, dir);

		const before = db
			.select()
			.from(workloads)
			.where(eq(workloads.name, "test-service"))
			.get();

		writeTs(dir, "svc.workload.ts", UPDATED_TS);
		await loadWorkloadsFromDir(db, dir);

		const after = db
			.select()
			.from(workloads)
			.where(eq(workloads.name, "test-service"))
			.get();

		expect(after!.workloadId).toBe(before!.workloadId);
	});
});
