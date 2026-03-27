import { describe, expect, test } from "bun:test";
import {
	TENANT_STATUSES,
	TENANT_EVENTS,
	tenantTransition,
} from "./tenant-state";
import { InvalidTransitionError } from "./state-machine";

describe("tenant state machine", () => {
	describe("valid transitions", () => {
		test("idle → claiming (via 'claim')", () => {
			expect(tenantTransition("idle", "claim")).toBe("claiming");
		});

		test("claiming → active (via 'claimed')", () => {
			expect(tenantTransition("claiming", "claimed")).toBe("active");
		});

		test("claiming → idle (via 'claim_failed')", () => {
			expect(tenantTransition("claiming", "claim_failed")).toBe("idle");
		});

		test("active → releasing (via 'release')", () => {
			expect(tenantTransition("active", "release")).toBe("releasing");
		});

		test("releasing → released (via 'hibernated')", () => {
			expect(tenantTransition("releasing", "hibernated")).toBe("released");
		});

		test("releasing → idle (via 'destroyed')", () => {
			expect(tenantTransition("releasing", "destroyed")).toBe("idle");
		});

		test("released → claiming (via 'claim')", () => {
			expect(tenantTransition("released", "claim")).toBe("claiming");
		});

		test("active → claiming (via 'claim', re-claim)", () => {
			expect(tenantTransition("active", "claim")).toBe("claiming");
		});

		test("releasing → active (via 'recover')", () => {
			expect(tenantTransition("releasing", "recover")).toBe("active");
		});
	});

	describe("invalid transitions", () => {
		test("idle → active throws (must claim first)", () => {
			expect(() => tenantTransition("idle", "claimed")).toThrow(
				InvalidTransitionError,
			);
		});

		test("released → active throws (must claim first)", () => {
			expect(() => tenantTransition("released", "claimed")).toThrow(
				InvalidTransitionError,
			);
		});
	});

	test("error includes entity name 'tenant'", () => {
		try {
			tenantTransition("idle", "claimed");
		} catch (e) {
			const err = e as InvalidTransitionError;
			expect(err.entity).toBe("tenant");
		}
	});

	test("all statuses enumerable", () => {
		expect(TENANT_STATUSES).toEqual([
			"idle",
			"claiming",
			"active",
			"releasing",
			"released",
		]);
	});

	test("all events enumerable", () => {
		expect(TENANT_EVENTS).toEqual([
			"claim",
			"claimed",
			"claim_failed",
			"release",
			"hibernated",
			"destroyed",
			"recover",
		]);
	});
});
