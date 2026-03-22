import { eq } from "drizzle-orm";
import type { Runtime, NodeId, InstanceStatus } from "@boilerhouse/core";
import { instances, claims } from "@boilerhouse/db";
import type { DrizzleDb, ActivityLog } from "@boilerhouse/db";
import { applyInstanceTransition, applyClaimTransition } from "./transitions";

export interface RecoveryReport {
	/** Instances confirmed alive in the runtime. */
	recovered: number;
	/** DB rows marked destroyed (instance gone from runtime). */
	destroyed: number;
	/** Claims reset from intermediate states (creating/releasing). */
	claimsReset: number;
}

/** Statuses that indicate an instance should be running in the runtime. */
const LIVE_STATUSES: InstanceStatus[] = ["active", "starting", "restoring"];

/**
 * Reconciles DB state with the actual runtime after a server restart.
 *
 * Instances marked as active/starting in the DB but absent from the runtime
 * are transitioned to "destroyed".
 *
 * Recovery intentionally writes status directly to the DB, bypassing the
 * state machines. This is the "force" escape hatch for crash recovery where
 * the in-flight state may be inconsistent.
 */
export async function recoverState(
	runtime: Runtime,
	db: DrizzleDb,
	nodeId: NodeId,
	activityLog: ActivityLog,
): Promise<RecoveryReport> {
	const report: RecoveryReport = {
		recovered: 0,
		destroyed: 0,
		claimsReset: 0,
	};

	// 1. Query instances that should have a live runtime instance
	const dbInstances = db
		.select()
		.from(instances)
		.where(eq(instances.nodeId, nodeId))
		.all()
		.filter((row) => LIVE_STATUSES.includes(row.status!));

	// 2. Get live instance set from runtime
	const liveInstances = new Set<string>(await runtime.list());

	// 3. Reconcile each DB instance
	for (const row of dbInstances) {
		if (liveInstances.has(row.instanceId)) {
			report.recovered++;
		} else {
			// Instance is gone — mark destroyed (skips intermediate destroying state)
			applyInstanceTransition(db, row.instanceId, row.status as InstanceStatus, "recover");

			// Log activity
			activityLog.log({
				instanceId: row.instanceId,
				workloadId: row.workloadId,
				nodeId,
				tenantId: row.tenantId,
				event: "recovery.destroyed",
				metadata: { previousStatus: row.status },
			});

			report.destroyed++;
		}
	}

	// 3b. Recover instances stuck in "destroying" or "hibernating" — cleanup already happened or failed
	const destroyingInstances = db
		.select()
		.from(instances)
		.where(eq(instances.nodeId, nodeId))
		.all()
		.filter((row) => row.status === "destroying" || row.status === "hibernating");

	for (const row of destroyingInstances) {
		applyInstanceTransition(db, row.instanceId, "destroying", "destroyed");

		activityLog.log({
			instanceId: row.instanceId,
			workloadId: row.workloadId,
			nodeId,
			event: "recovery.destroyed",
			metadata: { previousStatus: "destroying" },
		});

		report.destroyed++;
	}

	// 3c. Recover claims stuck in intermediate states
	const stuckClaims = db
		.select()
		.from(claims)
		.all()
		.filter((row) => row.status === "creating" || row.status === "releasing");

	for (const row of stuckClaims) {
		// Check if instance is still alive
		const instanceAlive = row.instanceId
			? liveInstances.has(row.instanceId)
			: false;

		if (row.status === "creating" || !instanceAlive) {
			// Instance never came up or is gone — delete claim
			db.delete(claims).where(eq(claims.claimId, row.claimId)).run();
		} else {
			// releasing with live instance — revert to active via recover event
			applyClaimTransition(db, row.claimId, "releasing", "recover");
		}

		activityLog.log({
			tenantId: row.tenantId,
			nodeId,
			event: "recovery.claim_reset",
			metadata: { previousStatus: row.status },
		});

		report.claimsReset++;
	}

	return report;
}
