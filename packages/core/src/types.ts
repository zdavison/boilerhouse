import { Type, type Static } from "@sinclair/typebox";

/** Brand symbol for nominal typing of ID types. */
declare const brand: unique symbol;

/** Branded string type — structurally incompatible with other branded IDs. */
type Brand<T, B> = T & { readonly [brand]: B };

// ── ID Schemas ───────────────────────────────────────────────────────────────
// Runtime schemas for API input validation. At runtime these are UUID strings;
// the branding is compile-time only.

/** @example "a1b2c3d4-e5f6-7890-abcd-ef1234567890" */
export const InstanceIdSchema = Type.String({ minLength: 1 });
/** @example "a1b2c3d4-e5f6-7890-abcd-ef1234567890" */
export const TenantIdSchema = Type.String({ minLength: 1 });
/** @example "a1b2c3d4-e5f6-7890-abcd-ef1234567890" */
export const WorkloadIdSchema = Type.String({ minLength: 1 });
/** @example "a1b2c3d4-e5f6-7890-abcd-ef1234567890" */
export const NodeIdSchema = Type.String({ minLength: 1 });
/** @example "a1b2c3d4-e5f6-7890-abcd-ef1234567890" */
export const SnapshotIdSchema = Type.String({ minLength: 1 });

// ── Branded ID types ─────────────────────────────────────────────────────────

/** Unique identifier for an instance (running microVM). */
export type InstanceId = Brand<Static<typeof InstanceIdSchema>, "InstanceId">;

/** Unique identifier for a tenant. */
export type TenantId = Brand<Static<typeof TenantIdSchema>, "TenantId">;

/** Unique identifier for a workload definition. */
export type WorkloadId = Brand<Static<typeof WorkloadIdSchema>, "WorkloadId">;

/** Unique identifier for a node (host machine). */
export type NodeId = Brand<Static<typeof NodeIdSchema>, "NodeId">;

/** Unique identifier for a snapshot. */
export type SnapshotId = Brand<Static<typeof SnapshotIdSchema>, "SnapshotId">;

// ── Factory functions ────────────────────────────────────────────────────────

export function generateInstanceId(): InstanceId {
	return crypto.randomUUID() as InstanceId;
}

export function generateTenantId(): TenantId {
	return crypto.randomUUID() as TenantId;
}

export function generateWorkloadId(): WorkloadId {
	return crypto.randomUUID() as WorkloadId;
}

export function generateNodeId(): NodeId {
	return crypto.randomUUID() as NodeId;
}

export function generateSnapshotId(): SnapshotId {
	return crypto.randomUUID() as SnapshotId;
}
