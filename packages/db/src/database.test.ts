import { describe, test, expect, afterAll } from "bun:test";
import { existsSync, unlinkSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestDatabase, initDatabase } from "./database";
import { nodes } from "./schema";
import type { NodeId, NodeCapacity } from "@boilerhouse/core";

describe("createTestDatabase", () => {
	test("returns a working in-memory database", () => {
		const db = createTestDatabase();
		const now = new Date();

		db.insert(nodes)
			.values({
				nodeId: "node-1" as NodeId,
				runtimeType: "podman",
				capacity: { vcpus: 4, memoryMb: 1024, diskGb: 10 } satisfies NodeCapacity,
				lastHeartbeat: now,
				createdAt: now,
			})
			.run();

		const rows = db.select().from(nodes).all();
		expect(rows).toHaveLength(1);
		expect(rows[0]!.nodeId).toBe("node-1" as NodeId);
	});

	test("each call returns an independent instance", () => {
		const db1 = createTestDatabase();
		const db2 = createTestDatabase();
		const now = new Date();

		db1.insert(nodes)
			.values({
				nodeId: "node-a" as NodeId,
				runtimeType: "podman",
				capacity: { vcpus: 2, memoryMb: 512, diskGb: 5 } satisfies NodeCapacity,
				lastHeartbeat: now,
				createdAt: now,
			})
			.run();

		const rows1 = db1.select().from(nodes).all();
		const rows2 = db2.select().from(nodes).all();

		expect(rows1).toHaveLength(1);
		expect(rows2).toHaveLength(0);
	});
});

describe("initDatabase", () => {
	const tempDir = mkdtempSync(join(tmpdir(), "boilerhouse-db-test-"));
	const dbPath = join(tempDir, "test.db");

	afterAll(() => {
		// Clean up temp files
		for (const suffix of ["", "-wal", "-shm"]) {
			const p = dbPath + suffix;
			if (existsSync(p)) unlinkSync(p);
		}
	});

	test("creates a file-based database", () => {
		const db = initDatabase(dbPath);
		const now = new Date();

		db.insert(nodes)
			.values({
				nodeId: "node-file" as NodeId,
				runtimeType: "podman",
				capacity: { vcpus: 8, memoryMb: 2048, diskGb: 20 } satisfies NodeCapacity,
				lastHeartbeat: now,
				createdAt: now,
			})
			.run();

		expect(existsSync(dbPath)).toBe(true);

		const rows = db.select().from(nodes).all();
		expect(rows).toHaveLength(1);
		expect(rows[0]!.runtimeType).toBe("podman");
	});
});
