import { describe, expect, test } from "bun:test";
import {
	SNAPSHOT_STATUSES,
	SNAPSHOT_EVENTS,
	snapshotTransition,
} from "./snapshot-state";
import { InvalidTransitionError } from "./state-machine";

describe("snapshot state machine", () => {
	describe("valid transitions", () => {
		test("creating → ready (via 'created')", () => {
			expect(snapshotTransition("creating", "created")).toBe("ready");
		});

		test("creating → deleted (via 'failed')", () => {
			expect(snapshotTransition("creating", "failed")).toBe("deleted");
		});

		test("ready → expired (via 'expire')", () => {
			expect(snapshotTransition("ready", "expire")).toBe("expired");
		});

		test("ready → deleted (via 'delete')", () => {
			expect(snapshotTransition("ready", "delete")).toBe("deleted");
		});

		test("expired → deleted (via 'delete')", () => {
			expect(snapshotTransition("expired", "delete")).toBe("deleted");
		});
	});

	describe("invalid transitions", () => {
		test("deleted → anything throws (terminal)", () => {
			for (const event of SNAPSHOT_EVENTS) {
				expect(() => snapshotTransition("deleted", event)).toThrow(
					InvalidTransitionError,
				);
			}
		});

		test("ready → creating throws", () => {
			expect(() => snapshotTransition("ready", "created")).toThrow(
				InvalidTransitionError,
			);
		});
	});

	test("error includes entity name 'snapshot'", () => {
		try {
			snapshotTransition("deleted", "created");
		} catch (e) {
			const err = e as InvalidTransitionError;
			expect(err.entity).toBe("snapshot");
		}
	});

	test("all statuses enumerable", () => {
		expect(SNAPSHOT_STATUSES).toEqual([
			"creating",
			"ready",
			"expired",
			"deleted",
		]);
	});

	test("all events enumerable", () => {
		expect(SNAPSHOT_EVENTS).toEqual([
			"created",
			"failed",
			"expire",
			"delete",
		]);
	});
});
