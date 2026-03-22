import { describe, expect, test } from "bun:test";
import {
    CLAIM_STATUSES,
    CLAIM_EVENTS,
    claimTransition,
} from "./claim-state";
import { InvalidTransitionError } from "./state-machine";

describe("claim state machine", () => {
    describe("valid transitions", () => {
        test("creating → active (via 'created')", () => {
            expect(claimTransition("creating", "created")).toBe("active");
        });

        test("active → releasing (via 'release')", () => {
            expect(claimTransition("active", "release")).toBe("releasing");
        });

        test("releasing → active (via 'recover')", () => {
            expect(claimTransition("releasing", "recover")).toBe("active");
        });
    });

    describe("invalid transitions", () => {
        test("creating → releasing throws", () => {
            expect(() => claimTransition("creating", "release")).toThrow(InvalidTransitionError);
        });

        test("creating → recover throws", () => {
            expect(() => claimTransition("creating", "recover")).toThrow(InvalidTransitionError);
        });

        test("active → created throws", () => {
            expect(() => claimTransition("active", "created")).toThrow(InvalidTransitionError);
        });

        test("active → recover throws", () => {
            expect(() => claimTransition("active", "recover")).toThrow(InvalidTransitionError);
        });

        test("releasing → created throws", () => {
            expect(() => claimTransition("releasing", "created")).toThrow(InvalidTransitionError);
        });

        test("releasing → release throws", () => {
            expect(() => claimTransition("releasing", "release")).toThrow(InvalidTransitionError);
        });
    });

    test("all statuses enumerable", () => {
        expect(CLAIM_STATUSES).toEqual(["creating", "active", "releasing"]);
    });

    test("all events enumerable", () => {
        expect(CLAIM_EVENTS).toEqual(["created", "release", "recover"]);
    });
});
