/**
 * Standalone transition functions that replace the Actor classes.
 *
 * Each function validates a state machine transition against the already-fetched
 * current status, writes the new status to the DB, and returns it. This eliminates
 * the redundant DB read that the Actor pattern required.
 */

import { eq } from "drizzle-orm";
import type {
	InstanceHandle,
	InstanceId,
	InstanceStatus,
	InstanceEvent,
	ClaimId,
	ClaimStatus,
	ClaimEvent,
	SnapshotId,
	SnapshotStatus,
	SnapshotEvent,
	WorkloadId,
	WorkloadStatus,
	WorkloadEvent,
} from "@boilerhouse/core";
import {
	transition,
	claimTransition,
	snapshotTransition,
	workloadTransition,
} from "@boilerhouse/core";
import type { DrizzleDb } from "@boilerhouse/db";
import { instances, claims, snapshots, workloads } from "@boilerhouse/db";

/**
 * Generic implementation: validate transition, write new status to DB, return it.
 * The `table` and `idColumn` args use `any` because drizzle's table/column types are
 * opaque generics — callers see the properly-typed wrappers below.
 */
// biome-ignore lint/suspicious/noExplicitAny: drizzle table/column types are opaque
function applyTransition<Status extends string, Event extends string>(
	db: DrizzleDb,
	// biome-ignore lint/suspicious/noExplicitAny: drizzle table/column types are opaque
	table: any,
	// biome-ignore lint/suspicious/noExplicitAny: drizzle table/column types are opaque
	idColumn: any,
	id: string,
	currentStatus: Status,
	event: Event,
	transitionFn: (status: Status, event: Event) => Status,
): Status {
	const next = transitionFn(currentStatus, event);
	db.update(table).set({ status: next }).where(eq(idColumn, id)).run();
	return next;
}

// ── Instance ─────────────────────────────────────────────────────────────────

/**
 * Validates the transition, writes new status to DB, returns the new status.
 * Throws {@link InvalidTransitionError} if the transition is not allowed.
 */
export function applyInstanceTransition(
	db: DrizzleDb,
	instanceId: InstanceId,
	currentStatus: InstanceStatus,
	event: InstanceEvent,
): InstanceStatus {
	return applyTransition(db, instances, instances.instanceId, instanceId, currentStatus, event, transition);
}

/**
 * Force-set an instance status without transition validation.
 */
export function forceInstanceStatus(
	db: DrizzleDb,
	instanceId: InstanceId,
	status: InstanceStatus,
): void {
	db.update(instances)
		.set({ status })
		.where(eq(instances.instanceId, instanceId))
		.run();
}

// ── Claim ────────────────────────────────────────────────────────────────────

/**
 * Validates the transition, writes new status to DB, returns the new status.
 * Throws {@link InvalidTransitionError} if the transition is not allowed.
 */
export function applyClaimTransition(
	db: DrizzleDb,
	claimId: ClaimId,
	currentStatus: ClaimStatus,
	event: ClaimEvent,
): ClaimStatus {
	return applyTransition(db, claims, claims.claimId, claimId, currentStatus, event, claimTransition);
}

// ── Snapshot ─────────────────────────────────────────────────────────────────

/**
 * Validates the transition, writes new status to DB, returns the new status.
 * Throws {@link InvalidTransitionError} if the transition is not allowed.
 */
export function applySnapshotTransition(
	db: DrizzleDb,
	snapshotId: SnapshotId,
	currentStatus: SnapshotStatus,
	event: SnapshotEvent,
): SnapshotStatus {
	return applyTransition(db, snapshots, snapshots.snapshotId, snapshotId, currentStatus, event, snapshotTransition);
}

// ── Workload ─────────────────────────────────────────────────────────────────

/**
 * Validates the transition, writes new status to DB, returns the new status.
 * Throws {@link InvalidTransitionError} if the transition is not allowed.
 */
export function applyWorkloadTransition(
	db: DrizzleDb,
	workloadId: WorkloadId,
	currentStatus: WorkloadStatus,
	event: WorkloadEvent,
): WorkloadStatus {
	return applyTransition(db, workloads, workloads.workloadId, workloadId, currentStatus, event, workloadTransition);
}

// ── Handle helpers ──────────────────────────────────────────────────────────

/** Derives an InstanceHandle from a DB row's status. */
export function instanceHandleFrom(instanceId: InstanceId, status: string): InstanceHandle {
	return { instanceId, running: status === "active" || status === "restoring" };
}

