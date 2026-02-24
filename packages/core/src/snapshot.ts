import { Type, type Static } from "@sinclair/typebox";
import {
	SnapshotIdSchema,
	WorkloadIdSchema,
	TenantIdSchema,
	NodeIdSchema,
} from "./types";
import type { SnapshotId, WorkloadId, TenantId, NodeId } from "./types";

// ── Schemas ──────────────────────────────────────────────────────────────────

export const SnapshotTypeSchema = Type.Union([
	Type.Literal("golden"),
	Type.Literal("tenant"),
]);

export const SnapshotPathsSchema = Type.Object({
	/** Primary snapshot data path (e.g. checkpoint archive). */
	memory: Type.String({ minLength: 1 }),
	/** Secondary snapshot data path, or same as `memory` for single-file formats. */
	vmstate: Type.String({ minLength: 1 }),
});

export const SnapshotMetadataSchema = Type.Object({
	/** Runtime version (e.g. podman version). */
	runtimeVersion: Type.String({ minLength: 1 }),
	/**
	 * Architecture of the snapshot.
	 * @example "x86_64"
	 */
	architecture: Type.String({ minLength: 1 }),
	/**
	 * Guest ports exposed by the workload.
	 * @example [8080, 9090]
	 */
	exposedPorts: Type.Optional(Type.Array(Type.Integer({ exclusiveMinimum: 0 }))),
});

export const SnapshotRefSchema = Type.Object({
	/** @example "a1b2c3d4-e5f6-7890-abcd-ef1234567890" */
	id: SnapshotIdSchema,
	type: SnapshotTypeSchema,
	paths: SnapshotPathsSchema,
	workloadId: WorkloadIdSchema,
	nodeId: NodeIdSchema,
	/** Present only for tenant snapshots. */
	tenantId: Type.Optional(TenantIdSchema),
	runtimeMeta: SnapshotMetadataSchema,
});

// ── Types ────────────────────────────────────────────────────────────────────

export type SnapshotType = Static<typeof SnapshotTypeSchema>;
export type SnapshotPaths = Static<typeof SnapshotPathsSchema>;
export type SnapshotMetadata = Static<typeof SnapshotMetadataSchema>;

// SnapshotRef keeps branded IDs for compile-time safety, while the schema
// handles runtime validation.
export interface SnapshotRef {
	/** @example "a1b2c3d4-e5f6-7890-abcd-ef1234567890" */
	id: SnapshotId;
	type: SnapshotType;
	paths: SnapshotPaths;
	workloadId: WorkloadId;
	nodeId: NodeId;
	/** Present only for tenant snapshots. */
	tenantId?: TenantId;
	runtimeMeta: SnapshotMetadata;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Creates a {@link SnapshotRef} from the given properties. */
export function createSnapshotRef(props: SnapshotRef): SnapshotRef {
	return { ...props };
}

export function isGoldenSnapshot(ref: SnapshotRef): boolean {
	return ref.type === "golden";
}

export function isTenantSnapshot(ref: SnapshotRef): boolean {
	return ref.type === "tenant";
}
