import { test, expect, describe, mock } from "bun:test";
import { createTestDatabase } from "@boilerhouse/db";
import { workloads } from "@boilerhouse/db";
import { generateWorkloadId } from "@boilerhouse/core";
import { prewarmPools } from "./startup-prewarm";

function makeWorkload(name: string, status: string) {
	return {
		workloadId: generateWorkloadId(),
		name,
		version: "1.0.0",
		status,
		statusDetail: null,
		config: { name, version: "1.0.0", image: { ref: "alpine:latest" } },
		createdAt: new Date(),
		updatedAt: new Date(),
	};
}

describe("prewarmPools", () => {
	test("calls replenish once per ready workload", () => {
		const db = createTestDatabase();
		const w1 = makeWorkload("app-a", "ready");
		const w2 = makeWorkload("app-b", "ready");
		db.insert(workloads).values([w1, w2]).run();

		const replenish = mock(() => Promise.resolve());
		const prime = mock(() => Promise.resolve());

		prewarmPools(db, { replenish, prime });

		expect(replenish).toHaveBeenCalledTimes(2);
	});

	test("does not call replenish when no workloads are ready", () => {
		const db = createTestDatabase();
		const w1 = makeWorkload("app-a", "error");
		const w2 = makeWorkload("app-b", "pending");
		db.insert(workloads).values([w1, w2]).run();

		const replenish = mock(() => Promise.resolve());
		const prime = mock(() => Promise.resolve());

		prewarmPools(db, { replenish, prime });

		expect(replenish).toHaveBeenCalledTimes(0);
	});

	test("does not pre-warm workloads in pending or error state", () => {
		const db = createTestDatabase();
		const w1 = makeWorkload("pending-app", "pending");
		const w2 = makeWorkload("error-app", "error");
		const w3 = makeWorkload("ready-app", "ready");
		db.insert(workloads).values([w1, w2, w3]).run();

		const replenish = mock(() => Promise.resolve());
		const prime = mock(() => Promise.resolve());

		prewarmPools(db, { replenish, prime });

		expect(replenish).toHaveBeenCalledTimes(1);
	});

	test("pre-warm is fire-and-forget (does not return a promise)", () => {
		const db = createTestDatabase();
		const w = makeWorkload("app-a", "ready");
		db.insert(workloads).values([w]).run();

		const replenish = mock(() => Promise.resolve());
		const prime = mock(() => Promise.resolve());

		const result = prewarmPools(db, { replenish, prime });

		// Fire-and-forget: returns void/undefined (not a promise)
		expect(result).toBeUndefined();
	});

	test("calls prime for workloads still in creating state", () => {
		const db = createTestDatabase();
		const w1 = makeWorkload("creating-app", "creating");
		db.insert(workloads).values([w1]).run();

		const replenish = mock(() => Promise.resolve());
		const prime = mock(() => Promise.resolve());

		prewarmPools(db, { replenish, prime });

		expect(prime).toHaveBeenCalledTimes(1);
		expect(replenish).toHaveBeenCalledTimes(0);
	});
});
