import { describe, expect, test } from "bun:test";
import {
	WORKLOAD_STATUSES,
	WORKLOAD_EVENTS,
	workloadTransition,
} from "./workload-state";
import { InvalidTransitionError } from "./state-machine";

describe("workload state machine", () => {
	describe("valid transitions", () => {
		test("creating → ready (via 'created')", () => {
			expect(workloadTransition("creating", "created")).toBe("ready");
		});

		test("creating → error (via 'failed')", () => {
			expect(workloadTransition("creating", "failed")).toBe("error");
		});

		test("error → creating (via 'retry')", () => {
			expect(workloadTransition("error", "retry")).toBe("creating");
		});
	});

	describe("invalid transitions", () => {
		test("ready → anything throws (terminal)", () => {
			for (const event of WORKLOAD_EVENTS) {
				expect(() => workloadTransition("ready", event)).toThrow(
					InvalidTransitionError,
				);
			}
		});

		test("creating → creating via 'retry' throws", () => {
			expect(() => workloadTransition("creating", "retry")).toThrow(
				InvalidTransitionError,
			);
		});

		test("error → ready via 'created' throws", () => {
			expect(() => workloadTransition("error", "created")).toThrow(
				InvalidTransitionError,
			);
		});
	});

	test("error includes entity name 'workload'", () => {
		try {
			workloadTransition("ready", "created");
		} catch (e) {
			const err = e as InvalidTransitionError;
			expect(err.entity).toBe("workload");
		}
	});

	test("all statuses enumerable", () => {
		expect(WORKLOAD_STATUSES).toEqual([
			"creating",
			"ready",
			"error",
		]);
	});

	test("all events enumerable", () => {
		expect(WORKLOAD_EVENTS).toEqual([
			"created",
			"failed",
			"retry",
		]);
	});
});
