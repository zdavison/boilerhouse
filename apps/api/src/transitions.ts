/**
 * Standalone transition functions that replace the Actor classes.
 *
 * Each function validates a state machine transition against the already-fetched
 * current status, writes the new status to the DB, and returns it. This eliminates
 * the redundant DB read that the Actor pattern required.
 */

import { eq } from "drizzle-orm";
import type {
	InstanceId,
	InstanceStatus,
	InstanceEvent,
	TenantId,
	TenantStatus,
	TenantEvent,
	SnapshotId,
	SnapshotStatus,
	SnapshotEvent,
	WorkloadId,
	WorkloadStatus,
	WorkloadEvent,
} from "@boilerhouse/core";
import {
	transition,
	tenantTransition,
	snapshotTransition,
	workloadTransition,
} from "@boilerhouse/core";
import type { DrizzleDb } from "@boilerhouse/db";
import { instances, tenants, snapshots, workloads } from "@boilerhouse/db";

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
	const next = transition(currentStatus, event);
	db.update(instances)
		.set({ status: next })
		.where(eq(instances.instanceId, instanceId))
		.run();
	return next;
}

/** Bypasses the state machine and writes status directly (recovery only). */
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

// ── Tenant ───────────────────────────────────────────────────────────────────

/**
 * Validates the transition, writes new status to DB, returns the new status.
 * Throws {@link InvalidTransitionError} if the transition is not allowed.
 */
export function applyTenantTransition(
	db: DrizzleDb,
	tenantId: TenantId,
	currentStatus: TenantStatus,
	event: TenantEvent,
): TenantStatus {
	const next = tenantTransition(currentStatus, event);
	db.update(tenants)
		.set({ status: next })
		.where(eq(tenants.tenantId, tenantId))
		.run();
	return next;
}

/** Bypasses the state machine and writes status directly (recovery only). */
export function forceTenantStatus(
	db: DrizzleDb,
	tenantId: TenantId,
	status: TenantStatus,
): void {
	db.update(tenants)
		.set({ status })
		.where(eq(tenants.tenantId, tenantId))
		.run();
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
	const next = snapshotTransition(currentStatus, event);
	db.update(snapshots)
		.set({ status: next })
		.where(eq(snapshots.snapshotId, snapshotId))
		.run();
	return next;
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
	const next = workloadTransition(currentStatus, event);
	db.update(workloads)
		.set({ status: next })
		.where(eq(workloads.workloadId, workloadId))
		.run();
	return next;
}

/** Bypasses the state machine and writes status directly (recovery only). */
export function forceWorkloadStatus(
	db: DrizzleDb,
	workloadId: WorkloadId,
	status: WorkloadStatus,
): void {
	db.update(workloads)
		.set({ status })
		.where(eq(workloads.workloadId, workloadId))
		.run();
}
