import { describe, expect, test } from "bun:test";
import {
	NODE_STATUSES,
	NODE_EVENTS,
	RUNTIME_TYPES,
	type NodeCapacity,
	validateNodeCapacity,
	NodeCapacityError,
	nodeTransition,
} from "./node";
import { InvalidTransitionError } from "./state-machine";

describe("node types", () => {
	test("node status values are exhaustive", () => {
		expect(NODE_STATUSES).toContain("online");
		expect(NODE_STATUSES).toContain("draining");
		expect(NODE_STATUSES).toContain("offline");
		expect(NODE_STATUSES).toHaveLength(3);
	});

	test("runtime types are exhaustive", () => {
		expect(RUNTIME_TYPES).toContain("podman");
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

describe("node state machine", () => {
	describe("valid transitions", () => {
		test("online → draining (via 'drain' event)", () => {
			expect(nodeTransition("online", "drain")).toBe("draining");
		});

		test("draining → offline (via 'shutdown' event)", () => {
			expect(nodeTransition("draining", "shutdown")).toBe("offline");
		});

		test("draining → online (via 'cancel_drain' event)", () => {
			expect(nodeTransition("draining", "cancel_drain")).toBe("online");
		});

		test("offline → online (via 'activate' event)", () => {
			expect(nodeTransition("offline", "activate")).toBe("online");
		});
	});

	describe("invalid transitions", () => {
		test("online → offline throws (must drain first)", () => {
			expect(() => nodeTransition("online", "shutdown")).toThrow(
				InvalidTransitionError,
			);
		});

		test("offline → draining throws", () => {
			expect(() => nodeTransition("offline", "drain")).toThrow(
				InvalidTransitionError,
			);
		});

		test("online → online via activate throws", () => {
			expect(() => nodeTransition("online", "activate")).toThrow(
				InvalidTransitionError,
			);
		});
	});

	test("error includes entity name 'node'", () => {
		try {
			nodeTransition("online", "shutdown");
		} catch (e) {
			const err = e as InvalidTransitionError;
			expect(err.entity).toBe("node");
		}
	});

	test("all events enumerable", () => {
		expect(NODE_EVENTS).toEqual([
			"drain",
			"shutdown",
			"cancel_drain",
			"activate",
		]);
	});
});
