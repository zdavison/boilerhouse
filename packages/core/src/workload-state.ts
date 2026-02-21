import { Type, type Static } from "@sinclair/typebox";
import { createMachine, type TransitionMap } from "./state-machine";

// ── Schemas ─────────────────────────────────────────────────────────────────

export const WorkloadStatusSchema = Type.Union([
	Type.Literal("creating"),
	Type.Literal("ready"),
	Type.Literal("error"),
]);

export const WorkloadEventSchema = Type.Union([
	Type.Literal("created"),
	Type.Literal("failed"),
	Type.Literal("retry"),
]);

// ── Types ───────────────────────────────────────────────────────────────────

export type WorkloadStatus = Static<typeof WorkloadStatusSchema>;
export type WorkloadEvent = Static<typeof WorkloadEventSchema>;

export const WORKLOAD_STATUSES = [
	"creating",
	"ready",
	"error",
] as const satisfies readonly WorkloadStatus[];

export const WORKLOAD_EVENTS = [
	"created",
	"failed",
	"retry",
] as const satisfies readonly WorkloadEvent[];

// ── Machine ─────────────────────────────────────────────────────────────────

const transitions: TransitionMap<WorkloadStatus, WorkloadEvent> = {
	creating: { created: "ready", failed: "error" },
	ready: {},
	error: { retry: "creating" },
};

const workloadMachine = createMachine<WorkloadStatus, WorkloadEvent>(
	"workload",
	{ transitions },
);

/**
 * Applies an event to the current workload status, returning the new status.
 * Throws {@link InvalidTransitionError} if the transition is not allowed.
 */
export function workloadTransition(
	current: WorkloadStatus,
	event: WorkloadEvent,
): WorkloadStatus {
	return workloadMachine.transition(current, event);
}
