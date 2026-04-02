import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { createTestDatabase, workloads } from "@boilerhouse/db";
import type { DrizzleDb } from "@boilerhouse/db";
import { loadWorkloadsFromDir } from "@boilerhouse/db";
import type { WorkloadId } from "@boilerhouse/core";
import { WorkloadWatcher } from "./workload-watcher";

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "workload-watcher-test-"));
}

function writeWorkload(dir: string, filename: string, config: Record<string, unknown>): void {
	writeFileSync(
		join(dir, filename),
		`export default ${JSON.stringify(config, null, 2)};`,
	);
}

function bumpMtime(filepath: string): void {
	const future = new Date(Date.now() + 2000);
	utimesSync(filepath, future, future);
}

const BASE_WORKLOAD = {
	name: "watch-test",
	version: "1.0.0",
	image: { ref: "ghcr.io/test/service:latest" },
	resources: { vcpus: 1, memory_mb: 512 },
};

describe("WorkloadWatcher", () => {
	let db: DrizzleDb;
	let dir: string;

	beforeEach(() => {
		db = createTestDatabase();
		dir = makeTempDir();
	});

	test("detects new workload file and triggers prime", async () => {
		const primed: WorkloadId[] = [];
		const drained: WorkloadId[] = [];

		const watcher = new WorkloadWatcher(db, dir, {
			onNew: async (workloadId) => { primed.push(workloadId); },
			onUpdated: async (workloadId) => { drained.push(workloadId); },
			pollIntervalMs: 50,
		});

		// Write a workload file after the watcher starts
		writeWorkload(dir, "svc.workload.ts", BASE_WORKLOAD);

		// Manually trigger a scan (simulates the poll tick)
		await watcher.scan();

		expect(primed).toHaveLength(1);
		expect(drained).toHaveLength(0);

		// Workload should be in the DB
		const row = db.select().from(workloads).where(eq(workloads.name, "watch-test")).get();
		expect(row).toBeTruthy();
		expect(row!.status).toBe("creating");

		watcher.stop();
	});

	test("detects config change and triggers update callback", async () => {
		// Pre-load the initial workload
		writeWorkload(dir, "svc.workload.ts", BASE_WORKLOAD);
		await loadWorkloadsFromDir(db, dir);

		// Mark it as ready (simulating successful prime)
		const row = db.select().from(workloads).where(eq(workloads.name, "watch-test")).get()!;
		db.update(workloads).set({ status: "ready" }).where(eq(workloads.workloadId, row.workloadId)).run();

		const updated: WorkloadId[] = [];
		const watcher = new WorkloadWatcher(db, dir, {
			onNew: async () => {},
			onUpdated: async (workloadId) => { updated.push(workloadId); },
			pollIntervalMs: 50,
		});

		// Modify the workload file
		writeWorkload(dir, "svc.workload.ts", { ...BASE_WORKLOAD, resources: { vcpus: 4, memory_mb: 2048 } });
		bumpMtime(join(dir, "svc.workload.ts"));

		await watcher.scan();

		expect(updated).toHaveLength(1);
		expect(updated[0]).toBe(row.workloadId);

		// Config should be updated in DB
		const after = db.select().from(workloads).where(eq(workloads.workloadId, row.workloadId)).get()!;
		expect(after.config.resources.memory_mb).toBe(2048);

		watcher.stop();
	});

	test("unchanged files do not trigger callbacks", async () => {
		writeWorkload(dir, "svc.workload.ts", BASE_WORKLOAD);
		await loadWorkloadsFromDir(db, dir);

		const row = db.select().from(workloads).where(eq(workloads.name, "watch-test")).get()!;
		db.update(workloads).set({ status: "ready" }).where(eq(workloads.workloadId, row.workloadId)).run();

		let callCount = 0;
		const watcher = new WorkloadWatcher(db, dir, {
			onNew: async () => { callCount++; },
			onUpdated: async () => { callCount++; },
			pollIntervalMs: 50,
		});

		await watcher.scan();
		await watcher.scan();
		await watcher.scan();

		expect(callCount).toBe(0);

		watcher.stop();
	});

	test("scan triggers automatically on poll interval", async () => {
		writeWorkload(dir, "svc.workload.ts", BASE_WORKLOAD);

		const primed: WorkloadId[] = [];
		const watcher = new WorkloadWatcher(db, dir, {
			onNew: async (workloadId) => { primed.push(workloadId); },
			onUpdated: async () => {},
			pollIntervalMs: 50,
		});

		watcher.start();

		// Wait enough time for at least one poll tick
		await new Promise((r) => setTimeout(r, 200));

		expect(primed.length).toBeGreaterThanOrEqual(1);

		watcher.stop();
	});

	test("workload transitions to creating on update (for re-priming)", async () => {
		writeWorkload(dir, "svc.workload.ts", BASE_WORKLOAD);
		await loadWorkloadsFromDir(db, dir);

		const row = db.select().from(workloads).where(eq(workloads.name, "watch-test")).get()!;
		db.update(workloads).set({ status: "ready" }).where(eq(workloads.workloadId, row.workloadId)).run();

		const watcher = new WorkloadWatcher(db, dir, {
			onNew: async () => {},
			onUpdated: async () => {},
			pollIntervalMs: 50,
		});

		writeWorkload(dir, "svc.workload.ts", { ...BASE_WORKLOAD, resources: { vcpus: 2, memory_mb: 1024 } });
		bumpMtime(join(dir, "svc.workload.ts"));

		await watcher.scan();

		// Workload should be back in "creating" state so the prime/healthcheck
		// flow can run before the pool is replaced
		const after = db.select().from(workloads).where(eq(workloads.workloadId, row.workloadId)).get()!;
		expect(after.status).toBe("creating");

		watcher.stop();
	});
});
