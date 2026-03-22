import { describe, expect, test } from "bun:test";
import {
	createMachine,
	InvalidTransitionError,
	type TransitionMap,
} from "./state-machine";

type Status = "idle" | "running" | "stopped";
type Event = "start" | "stop" | "reset";

const transitions: TransitionMap<Status, Event> = {
	idle: { start: "running" },
	running: { stop: "stopped" },
	stopped: { reset: "idle" },
};

const machine = createMachine("test-entity", { transitions });

describe("createMachine", () => {
	describe("transition()", () => {
		test("returns new state for valid transitions", () => {
			expect(machine.transition("idle", "start")).toBe("running");
			expect(machine.transition("running", "stop")).toBe("stopped");
			expect(machine.transition("stopped", "reset")).toBe("idle");
		});

		test("throws InvalidTransitionError for invalid transitions", () => {
			expect(() => machine.transition("idle", "stop")).toThrow(
				InvalidTransitionError,
			);
		});

		test("entity name is included in error", () => {
			try {
				machine.transition("idle", "stop");
			} catch (e) {
				const err = e as InvalidTransitionError;
				expect(err.entity).toBe("test-entity");
				expect(err.status).toBe("idle");
				expect(err.event).toBe("stop");
				expect(err.message).toContain("test-entity");
				expect(err.message).toContain("idle");
				expect(err.message).toContain("stop");
			}
		});

		test("terminal states reject all events", () => {
			const terminalMap: TransitionMap<"alive" | "dead", "kill"> = {
				alive: { kill: "dead" },
				dead: {},
			};
			const m = createMachine("mortal", { transitions: terminalMap });
			expect(() => m.transition("dead", "kill")).toThrow(
				InvalidTransitionError,
			);
		});
	});

	describe("can()", () => {
		test("returns true for valid transitions", () => {
			expect(machine.can("idle", "start")).toBe(true);
			expect(machine.can("running", "stop")).toBe(true);
		});

		test("returns false for invalid transitions", () => {
			expect(machine.can("idle", "stop")).toBe(false);
			expect(machine.can("stopped", "stop")).toBe(false);
		});

		test("never throws", () => {
			expect(machine.can("idle", "stop")).toBe(false);
		});
	});

	describe("guards", () => {
		test("guard returning true allows transition", () => {
			const guarded = createMachine<Status, Event, { allowed: boolean }>(
				"guarded",
				{
					transitions,
					guards: [
						(_status, event, ctx) => {
							if (event === "start") return ctx?.allowed ?? false;
							return true;
						},
					],
				},
			);

			expect(guarded.transition("idle", "start", { allowed: true })).toBe(
				"running",
			);
		});

		test("guard returning false blocks transition", () => {
			const guarded = createMachine<Status, Event, { allowed: boolean }>(
				"guarded",
				{
					transitions,
					guards: [
						(_status, event, ctx) => {
							if (event === "start") return ctx?.allowed ?? false;
							return true;
						},
					],
				},
			);

			expect(() =>
				guarded.transition("idle", "start", { allowed: false }),
			).toThrow(InvalidTransitionError);
		});

		test("guard returning string reason blocks with that reason", () => {
			const guarded = createMachine<Status, Event, undefined>(
				"reason-entity",
				{
					transitions,
					guards: [
						(_status, event) => {
							if (event === "start") return "not ready yet";
							return true;
						},
					],
				},
			);

			try {
				guarded.transition("idle", "start");
			} catch (e) {
				const err = e as InvalidTransitionError;
				expect(err.reason).toBe("not ready yet");
				expect(err.message).toContain("not ready yet");
			}
		});

		test("guard does not affect can()", () => {
			const guarded = createMachine<Status, Event, { allowed: boolean }>(
				"guarded",
				{
					transitions,
					guards: [
						(_status, event, ctx) => {
							if (event === "start") return ctx?.allowed ?? false;
							return true;
						},
					],
				},
			);

			// can() ignores guards — only checks if transition exists in map
			expect(guarded.can("idle", "start")).toBe(true);
		});
	});
});
