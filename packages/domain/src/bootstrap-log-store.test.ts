import { describe, test, expect, beforeEach } from "bun:test";
import type { WorkloadId } from "@boilerhouse/core";
import { createTestDatabase, type DrizzleDb } from "@boilerhouse/db";
import { BootstrapLogStore } from "./bootstrap-log-store";

const WID = "wkl-test-1" as WorkloadId;
const WID2 = "wkl-test-2" as WorkloadId;

let db: DrizzleDb;

beforeEach(() => {
	db = createTestDatabase();
});

describe("BootstrapLogStore", () => {
	test("append stores lines with timestamps", () => {
		const store = new BootstrapLogStore(db);

		const entry = store.append(WID, "Pulling image...");

		expect(entry.text).toBe("Pulling image...");
		expect(entry.timestamp).toBeDefined();
		// Timestamp should be a valid ISO string
		expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
	});

	test("getLines returns empty array for unknown workload", () => {
		const store = new BootstrapLogStore(db);

		expect(store.getLines(WID)).toEqual([]);
	});

	test("getLines returns all appended lines in order", () => {
		const store = new BootstrapLogStore(db);

		store.append(WID, "line 1");
		store.append(WID, "line 2");
		store.append(WID, "line 3");

		const lines = store.getLines(WID);
		expect(lines).toHaveLength(3);
		expect(lines[0]!.text).toBe("line 1");
		expect(lines[1]!.text).toBe("line 2");
		expect(lines[2]!.text).toBe("line 3");
	});

	test("keeps workloads separate", () => {
		const store = new BootstrapLogStore(db);

		store.append(WID, "from wid1");
		store.append(WID2, "from wid2");

		expect(store.getLines(WID)).toHaveLength(1);
		expect(store.getLines(WID2)).toHaveLength(1);
		expect(store.getLines(WID)[0]!.text).toBe("from wid1");
		expect(store.getLines(WID2)[0]!.text).toBe("from wid2");
	});

	test("clear removes all lines", () => {
		const store = new BootstrapLogStore(db);

		store.append(WID, "line 1");
		store.append(WID, "line 2");

		store.clear(WID);

		expect(store.getLines(WID)).toEqual([]);
	});

	test("clear does not affect other workloads", () => {
		const store = new BootstrapLogStore(db);

		store.append(WID, "keep me");
		store.append(WID2, "delete me");

		store.clear(WID2);

		expect(store.getLines(WID)).toHaveLength(1);
		expect(store.getLines(WID2)).toEqual([]);
	});

	test("maxLines eviction retains only tail", () => {
		const store = new BootstrapLogStore(db, 3);

		store.append(WID, "line 1");
		store.append(WID, "line 2");
		store.append(WID, "line 3");
		store.append(WID, "line 4");
		store.append(WID, "line 5");

		const lines = store.getLines(WID);
		expect(lines).toHaveLength(3);
		expect(lines[0]!.text).toBe("line 3");
		expect(lines[1]!.text).toBe("line 4");
		expect(lines[2]!.text).toBe("line 5");
	});
});
