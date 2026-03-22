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

		test("starting → restoring (via 'restoring' event)", () => {
			expect(transition("starting", "restoring")).toBe("restoring");
		});

		test("starting → destroying (via 'destroy' event)", () => {
			expect(transition("starting", "destroy")).toBe("destroying");
		});

		test("restoring → active (via 'restored' event)", () => {
			expect(transition("restoring", "restored")).toBe("active");
		});

		test("restoring → destroying (via 'destroy' event)", () => {
			expect(transition("restoring", "destroy")).toBe("destroying");
		});

		test("active → hibernating (via 'hibernate' event)", () => {
			expect(transition("active", "hibernate")).toBe("hibernating");
		});

		test("active → destroying (via 'destroy' event)", () => {
			expect(transition("active", "destroy")).toBe("destroying");
		});

		test("hibernating → hibernated (via 'hibernated' event)", () => {
			expect(transition("hibernating", "hibernated")).toBe("hibernated");
		});

		test("hibernating → destroying (via 'hibernating_failed' event)", () => {
			expect(transition("hibernating", "hibernating_failed")).toBe("destroying");
		});

		test("hibernated → restoring (via 'restoring' event)", () => {
			expect(transition("hibernated", "restoring")).toBe("restoring");
		});

		test("hibernated → destroying (via 'destroy' event)", () => {
			expect(transition("hibernated", "destroy")).toBe("destroying");
		});

		test("destroying → destroyed (via 'destroyed' event)", () => {
			expect(transition("destroying", "destroyed")).toBe("destroyed");
		});

		test("starting → destroyed (via 'recover' event)", () => {
			expect(transition("starting", "recover")).toBe("destroyed");
		});

		test("active → destroyed (via 'recover' event)", () => {
			expect(transition("active", "recover")).toBe("destroyed");
		});
	});

	describe("invalid transitions", () => {
		test("starting → hibernating throws", () => {
			expect(() => transition("starting", "hibernate")).toThrow(
				InvalidTransitionError,
			);
		});

		test("hibernated → active throws", () => {
			expect(() => transition("hibernated", "started")).toThrow(
				InvalidTransitionError,
			);
		});

		test("restoring → hibernating throws", () => {
			expect(() => transition("restoring", "hibernate")).toThrow(
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
		expect(INSTANCE_STATUSES).toContain("restoring");
		expect(INSTANCE_STATUSES).toContain("active");
		expect(INSTANCE_STATUSES).toContain("hibernating");
		expect(INSTANCE_STATUSES).toContain("hibernated");
		expect(INSTANCE_STATUSES).toContain("destroying");
		expect(INSTANCE_STATUSES).toContain("destroyed");
		expect(INSTANCE_STATUSES).toHaveLength(7);
	});

	test("all events are enumerable", () => {
		expect(INSTANCE_EVENTS).toContain("started");
		expect(INSTANCE_EVENTS).toContain("restoring");
		expect(INSTANCE_EVENTS).toContain("restored");
		expect(INSTANCE_EVENTS).toContain("hibernate");
		expect(INSTANCE_EVENTS).toContain("hibernated");
		expect(INSTANCE_EVENTS).toContain("hibernating_failed");
		expect(INSTANCE_EVENTS).toContain("destroy");
		expect(INSTANCE_EVENTS).toContain("destroyed");
		expect(INSTANCE_EVENTS).toContain("recover");
		expect(INSTANCE_EVENTS).toHaveLength(9);
	});

	test("InvalidTransitionError has structured fields", () => {
		try {
			transition("destroyed", "started");
		} catch (e) {
			expect(e).toBeInstanceOf(InvalidTransitionError);
			const err = e as InvalidTransitionError;
			expect(err.entity).toBe("instance");
			expect(err.status).toBe("destroyed");
			expect(err.event).toBe("started");
			expect(err.message).toContain("destroyed");
			expect(err.message).toContain("started");
		}
	});
});
