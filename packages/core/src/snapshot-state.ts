import { Type, type Static } from "@sinclair/typebox";
import { createMachine, type TransitionMap } from "./state-machine";

// ── Schemas ─────────────────────────────────────────────────────────────────

export const SnapshotStatusSchema = Type.Union([
	Type.Literal("creating"),
	Type.Literal("ready"),
	Type.Literal("expired"),
	Type.Literal("deleted"),
]);

export const SnapshotEventSchema = Type.Union([
	Type.Literal("created"),
	Type.Literal("failed"),
	Type.Literal("expire"),
	Type.Literal("delete"),
]);

// ── Types ───────────────────────────────────────────────────────────────────

export type SnapshotStatus = Static<typeof SnapshotStatusSchema>;
export type SnapshotEvent = Static<typeof SnapshotEventSchema>;

export const SNAPSHOT_STATUSES = [
	"creating",
	"ready",
	"expired",
	"deleted",
] as const satisfies readonly SnapshotStatus[];

export const SNAPSHOT_EVENTS = [
	"created",
	"failed",
	"expire",
	"delete",
] as const satisfies readonly SnapshotEvent[];

// ── Machine ─────────────────────────────────────────────────────────────────

const transitions: TransitionMap<SnapshotStatus, SnapshotEvent> = {
	creating: { created: "ready", failed: "deleted" },
	ready: { expire: "expired", delete: "deleted" },
	expired: { delete: "deleted" },
	deleted: {},
};

const snapshotMachine = createMachine<SnapshotStatus, SnapshotEvent>(
	"snapshot",
	{ transitions },
);

/**
 * Applies an event to the current snapshot status, returning the new status.
 * Throws {@link InvalidTransitionError} if the transition is not allowed.
 */
export function snapshotTransition(
	current: SnapshotStatus,
	event: SnapshotEvent,
): SnapshotStatus {
	return snapshotMachine.transition(current, event);
}

/** Checks whether the given event is valid for the current snapshot status. */
export function canSnapshotTransition(
	current: SnapshotStatus,
	event: SnapshotEvent,
): boolean {
	return snapshotMachine.can(current, event);
}
