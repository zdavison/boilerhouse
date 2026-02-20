import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const NodeStatusSchema = Type.Union([
	Type.Literal("online"),
	Type.Literal("draining"),
	Type.Literal("offline"),
]);
export type NodeStatus = Static<typeof NodeStatusSchema>;
export const NODE_STATUSES = ["online", "draining", "offline"] as const;

export const RuntimeTypeSchema = Type.Union([
	Type.Literal("firecracker"),
	Type.Literal("vz"),
]);
export type RuntimeType = Static<typeof RuntimeTypeSchema>;
export const RUNTIME_TYPES = ["firecracker", "vz"] as const;

export const NodeCapacitySchema = Type.Object({
	vcpus: Type.Integer({ exclusiveMinimum: 0 }),
	memoryMb: Type.Integer({ exclusiveMinimum: 0 }),
	diskGb: Type.Integer({ exclusiveMinimum: 0 }),
});
export type NodeCapacity = Static<typeof NodeCapacitySchema>;

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
