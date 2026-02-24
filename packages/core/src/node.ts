import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { createMachine, type TransitionMap } from "./state-machine";

export const NodeStatusSchema = Type.Union([
	Type.Literal("online"),
	Type.Literal("draining"),
	Type.Literal("offline"),
]);
export type NodeStatus = Static<typeof NodeStatusSchema>;
export const NODE_STATUSES = ["online", "draining", "offline"] as const;

export const RuntimeTypeSchema = Type.Union([
	Type.Literal("podman"),
	Type.Literal("vz"),
]);
export type RuntimeType = Static<typeof RuntimeTypeSchema>;
export const RUNTIME_TYPES = ["podman", "vz"] as const;

export const NodeCapacitySchema = Type.Object({
	vcpus: Type.Integer({ exclusiveMinimum: 0 }),
	memoryMb: Type.Integer({ exclusiveMinimum: 0 }),
	diskGb: Type.Integer({ exclusiveMinimum: 0 }),
});
export type NodeCapacity = Static<typeof NodeCapacitySchema>;

// ── Node events ─────────────────────────────────────────────────────────────

export const NodeEventSchema = Type.Union([
	Type.Literal("drain"),
	Type.Literal("shutdown"),
	Type.Literal("cancel_drain"),
	Type.Literal("activate"),
]);
export type NodeEvent = Static<typeof NodeEventSchema>;
export const NODE_EVENTS = [
	"drain",
	"shutdown",
	"cancel_drain",
	"activate",
] as const satisfies readonly NodeEvent[];

const nodeTransitions: TransitionMap<NodeStatus, NodeEvent> = {
	online: { drain: "draining" },
	draining: { shutdown: "offline", cancel_drain: "online" },
	offline: { activate: "online" },
};

const nodeMachine = createMachine<NodeStatus, NodeEvent>("node", {
	transitions: nodeTransitions,
});

/**
 * Applies an event to the current node status, returning the new status.
 * Throws {@link InvalidTransitionError} if the transition is not allowed.
 */
export function nodeTransition(
	current: NodeStatus,
	event: NodeEvent,
): NodeStatus {
	return nodeMachine.transition(current, event);
}

// ── Capacity validation ─────────────────────────────────────────────────────

export class NodeCapacityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "NodeCapacityError";
	}
}

/**
 * Validates that all capacity values are positive integers.
 * Throws {@link NodeCapacityError} if any value is invalid.
 */
export function validateNodeCapacity(capacity: NodeCapacity): void {
	if (!Value.Check(NodeCapacitySchema, capacity)) {
		const errors = [...Value.Errors(NodeCapacitySchema, capacity)];
		const first = errors[0]!;
		const field = first.path.replace(/^\//, "");
		throw new NodeCapacityError(`${field}: ${first.message}`);
	}
}
