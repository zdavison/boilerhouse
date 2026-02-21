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
	Type.Literal("active"),
	Type.Literal("hibernated"),
	Type.Literal("stopping"),
	Type.Literal("destroying"),
	Type.Literal("destroyed"),
]);

export const InstanceEventSchema = Type.Union([
	Type.Literal("started"),
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
	"hibernate",
	"stop",
	"destroy",
	"restore",
	"stopped",
	"destroyed",
] as const satisfies readonly InstanceEvent[];

// ── Machine ─────────────────────────────────────────────────────────────────

const transitions: TransitionMap<InstanceStatus, InstanceEvent> = {
	starting: { started: "active" },
	active: { hibernate: "hibernated", stop: "stopping", destroy: "destroying" },
	hibernated: { restore: "starting", destroy: "destroying" },
	stopping: { stopped: "destroyed" },
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
