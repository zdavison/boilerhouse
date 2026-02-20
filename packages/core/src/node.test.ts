import { describe, expect, test } from "bun:test";
import {
	NODE_STATUSES,
	RUNTIME_TYPES,
	type NodeCapacity,
	validateNodeCapacity,
	NodeCapacityError,
} from "./node";

describe("node types", () => {
	test("node status values are exhaustive", () => {
		expect(NODE_STATUSES).toContain("online");
		expect(NODE_STATUSES).toContain("draining");
		expect(NODE_STATUSES).toContain("offline");
		expect(NODE_STATUSES).toHaveLength(3);
	});

	test("runtime types are exhaustive", () => {
		expect(RUNTIME_TYPES).toContain("firecracker");
		expect(RUNTIME_TYPES).toContain("vz");
		expect(RUNTIME_TYPES).toHaveLength(2);
	});

	describe("capacity validation", () => {
		test("accepts valid positive integers", () => {
			const capacity: NodeCapacity = { vcpus: 8, memoryMb: 16384, diskGb: 500 };
			expect(() => validateNodeCapacity(capacity)).not.toThrow();
		});

		test("rejects zero vcpus", () => {
			expect(() =>
				validateNodeCapacity({ vcpus: 0, memoryMb: 1024, diskGb: 10 }),
			).toThrow(NodeCapacityError);
		});

		test("rejects negative memoryMb", () => {
			expect(() =>
				validateNodeCapacity({ vcpus: 2, memoryMb: -1, diskGb: 10 }),
			).toThrow(NodeCapacityError);
		});

		test("rejects negative diskGb", () => {
			expect(() =>
				validateNodeCapacity({ vcpus: 2, memoryMb: 1024, diskGb: -5 }),
			).toThrow(NodeCapacityError);
		});

		test("rejects non-integer vcpus", () => {
			expect(() =>
				validateNodeCapacity({ vcpus: 1.5, memoryMb: 1024, diskGb: 10 }),
			).toThrow(NodeCapacityError);
		});

		test("rejects non-integer memoryMb", () => {
			expect(() =>
				validateNodeCapacity({ vcpus: 2, memoryMb: 1024.5, diskGb: 10 }),
			).toThrow(NodeCapacityError);
		});

		test("rejects non-integer diskGb", () => {
			expect(() =>
				validateNodeCapacity({ vcpus: 2, memoryMb: 1024, diskGb: 10.1 }),
			).toThrow(NodeCapacityError);
		});
	});
});
