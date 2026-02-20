import { describe, expect, test } from "bun:test";
import {
	type InstanceStatus,
	INSTANCE_STATUSES,
	INSTANCE_EVENTS,
	transition,
	InvalidTransitionError,
} from "./instance-state";

describe("instance state machine", () => {
	describe("valid transitions", () => {
		test("starting → active (via 'started' event)", () => {
			expect(transition("starting", "started")).toBe("active");
		});

		test("active → hibernated (via 'hibernate' event)", () => {
			expect(transition("active", "hibernate")).toBe("hibernated");
		});

		test("active → stopping (via 'stop' event)", () => {
			expect(transition("active", "stop")).toBe("stopping");
		});

		test("active → destroying (via 'destroy' event)", () => {
			expect(transition("active", "destroy")).toBe("destroying");
		});

		test("stopping → destroyed (via 'stopped' event)", () => {
			expect(transition("stopping", "stopped")).toBe("destroyed");
		});

		test("destroying → destroyed (via 'destroyed' event)", () => {
			expect(transition("destroying", "destroyed")).toBe("destroyed");
		});

		test("hibernated → starting (via 'restore' event)", () => {
			expect(transition("hibernated", "restore")).toBe("starting");
		});
	});

	describe("invalid transitions", () => {
		test("starting → hibernated throws", () => {
			expect(() => transition("starting", "hibernate")).toThrow(
				InvalidTransitionError,
			);
		});

		test("hibernated → active throws", () => {
			expect(() => transition("hibernated", "started")).toThrow(
				InvalidTransitionError,
			);
		});

		test("stopping → active throws", () => {
			expect(() => transition("stopping", "started")).toThrow(
				InvalidTransitionError,
			);
		});

		test("destroyed → anything throws", () => {
			for (const event of INSTANCE_EVENTS) {
				expect(() => transition("destroyed", event)).toThrow(
					InvalidTransitionError,
				);
			}
		});
	});

	test("transition returns the new state (immutable — does not mutate input)", () => {
		const current: InstanceStatus = "starting";
		const next = transition(current, "started");

		expect(next).toBe("active");
		// Original value is unchanged (strings are immutable, but verifying the contract)
		expect(current).toBe("starting");
	});

	test("all states are enumerable", () => {
		expect(INSTANCE_STATUSES).toContain("starting");
		expect(INSTANCE_STATUSES).toContain("active");
		expect(INSTANCE_STATUSES).toContain("hibernated");
		expect(INSTANCE_STATUSES).toContain("stopping");
		expect(INSTANCE_STATUSES).toContain("destroying");
		expect(INSTANCE_STATUSES).toContain("destroyed");
		expect(INSTANCE_STATUSES).toHaveLength(6);
	});

	test("all events are enumerable", () => {
		expect(INSTANCE_EVENTS).toContain("started");
		expect(INSTANCE_EVENTS).toContain("claimed");
		expect(INSTANCE_EVENTS).toContain("hibernate");
		expect(INSTANCE_EVENTS).toContain("stop");
		expect(INSTANCE_EVENTS).toContain("destroy");
		expect(INSTANCE_EVENTS).toContain("restore");
		expect(INSTANCE_EVENTS).toContain("stopped");
		expect(INSTANCE_EVENTS).toContain("destroyed");
		expect(INSTANCE_EVENTS).toHaveLength(8);
	});

	test("InvalidTransitionError has structured message", () => {
		try {
			transition("destroyed", "started");
		} catch (e) {
			expect(e).toBeInstanceOf(InvalidTransitionError);
			const err = e as InvalidTransitionError;
			expect(err.currentStatus).toBe("destroyed");
			expect(err.event).toBe("started");
			expect(err.message).toContain("destroyed");
			expect(err.message).toContain("started");
		}
	});
});
