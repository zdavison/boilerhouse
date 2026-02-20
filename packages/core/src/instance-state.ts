import { Type, type Static } from "@sinclair/typebox";
import { setup, getNextSnapshot } from "xstate";

// ── Schemas (for API input validation via TypeBox / Elysia) ──────────────────

export const InstanceStatusSchema = Type.Union([
	Type.Literal("starting"),
	Type.Literal("active"),
	Type.Literal("hibernated"),
	Type.Literal("stopping"),
	Type.Literal("destroying"),
	Type.Literal("destroyed"),
]);

export const InstanceEventSchema = Type.Union([
	Type.Literal("started"),
	Type.Literal("claimed"),
	Type.Literal("hibernate"),
	Type.Literal("stop"),
	Type.Literal("destroy"),
	Type.Literal("restore"),
	Type.Literal("stopped"),
	Type.Literal("destroyed"),
]);

// ── Types ────────────────────────────────────────────────────────────────────

export type InstanceStatus = Static<typeof InstanceStatusSchema>;
export type InstanceEvent = Static<typeof InstanceEventSchema>;

export const INSTANCE_STATUSES = [
	"starting",
	"active",
	"hibernated",
	"stopping",
	"destroying",
	"destroyed",
] as const satisfies readonly InstanceStatus[];

export const INSTANCE_EVENTS = [
	"started",
	"claimed",
	"hibernate",
	"stop",
	"destroy",
	"restore",
	"stopped",
	"destroyed",
] as const satisfies readonly InstanceEvent[];

// ── XState machine ───────────────────────────────────────────────────────────

/** XState machine definition for the instance lifecycle. Exported for
 *  visualization (stately.ai inspector, VS Code extension) and direct
 *  actor usage in higher-level orchestration. */
export const instanceMachine = setup({
	types: {
		events: {} as
			| { type: "started" }
			| { type: "claimed" }
			| { type: "hibernate" }
			| { type: "stop" }
			| { type: "destroy" }
			| { type: "restore" }
			| { type: "stopped" }
			| { type: "destroyed" },
	},
}).createMachine({
	id: "instance",
	initial: "starting",
	states: {
		starting: {
			on: { started: { target: "active" } },
		},
		active: {
			on: {
				hibernate: { target: "hibernated" },
				stop: { target: "stopping" },
				destroy: { target: "destroying" },
			},
		},
		hibernated: {
			on: { restore: { target: "starting" } },
		},
		stopping: {
			on: { stopped: { target: "destroyed" } },
		},
		destroying: {
			on: { destroyed: { target: "destroyed" } },
		},
		destroyed: {
			type: "final",
		},
	},
});

// ── Pure transition function ─────────────────────────────────────────────────

export class InvalidTransitionError extends Error {
	constructor(
		public readonly currentStatus: InstanceStatus,
		public readonly event: InstanceEvent,
	) {
		super(
			`Invalid transition: cannot apply event '${event}' in status '${currentStatus}'`,
		);
		this.name = "InvalidTransitionError";
	}
}

/**
 * Applies an event to the current instance status, returning the new status.
 * Throws {@link InvalidTransitionError} if the transition is not allowed.
 *
 * This is a pure wrapper around the XState machine for callers that only
 * need a `(status, event) → status` function without actors.
 */
export function transition(
	current: InstanceStatus,
	event: InstanceEvent,
): InstanceStatus {
	const snapshot = instanceMachine.resolveState({ value: current });
	const next = getNextSnapshot(instanceMachine, snapshot, { type: event });
	const nextValue = next.value as InstanceStatus;

	if (nextValue === current) {
		throw new InvalidTransitionError(current, event);
	}

	return nextValue;
}
