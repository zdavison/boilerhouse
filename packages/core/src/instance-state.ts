import { Type, type Static } from "@sinclair/typebox";
import {
	createMachine,
	InvalidTransitionError,
	type TransitionMap,
} from "./state-machine";

// Re-export so consumers can catch the shared error type
export { InvalidTransitionError };

// ── Schemas (for API input validation via TypeBox / Elysia) ──────────────────

export const InstanceStatusSchema = Type.Union([
	Type.Literal("starting"),
	Type.Literal("restoring"),
	Type.Literal("active"),
	Type.Literal("hibernating"),
	Type.Literal("hibernated"),
	Type.Literal("destroying"),
	Type.Literal("destroyed"),
]);

export const InstanceEventSchema = Type.Union([
	Type.Literal("started"),
	Type.Literal("restoring"),
	Type.Literal("restored"),
	Type.Literal("hibernate"),
	Type.Literal("hibernated"),
	Type.Literal("hibernating_failed"),
	Type.Literal("destroy"),
	Type.Literal("destroyed"),
	Type.Literal("recover"),
]);

// ── Types ────────────────────────────────────────────────────────────────────

export type InstanceStatus = Static<typeof InstanceStatusSchema>;
export type InstanceEvent = Static<typeof InstanceEventSchema>;

export const INSTANCE_STATUSES = [
	"starting",
	"restoring",
	"active",
	"hibernating",
	"hibernated",
	"destroying",
	"destroyed",
] as const satisfies readonly InstanceStatus[];

export const INSTANCE_EVENTS = [
	"started",
	"restoring",
	"restored",
	"hibernate",
	"hibernated",
	"hibernating_failed",
	"destroy",
	"destroyed",
	"recover",
] as const satisfies readonly InstanceEvent[];

// ── Machine ─────────────────────────────────────────────────────────────────

const transitions: TransitionMap<InstanceStatus, InstanceEvent> = {
	starting: { started: "active", restoring: "restoring", destroy: "destroying", recover: "destroyed" },
	restoring: { restored: "active", destroy: "destroying" },
	active: { hibernate: "hibernating", destroy: "destroying", recover: "destroyed" },
	hibernating: { hibernated: "hibernated", hibernating_failed: "destroying" },
	hibernated: { restoring: "restoring", destroy: "destroying" },
	destroying: { destroyed: "destroyed" },
	destroyed: {},
};

const instanceMachine = createMachine<InstanceStatus, InstanceEvent>(
	"instance",
	{ transitions },
);

/**
 * Applies an event to the current instance status, returning the new status.
 * Throws {@link InvalidTransitionError} if the transition is not allowed.
 */
export function transition(
	current: InstanceStatus,
	event: InstanceEvent,
): InstanceStatus {
	return instanceMachine.transition(current, event);
}

/** Checks whether the given event is valid for the current instance status. */
export function canTransition(
	current: InstanceStatus,
	event: InstanceEvent,
): boolean {
	return instanceMachine.can(current, event);
}
