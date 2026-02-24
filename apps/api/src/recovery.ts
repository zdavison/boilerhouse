import { eq } from "drizzle-orm";
import type { Runtime, NodeId, InstanceStatus, TenantStatus } from "@boilerhouse/core";
import { instances, tenants } from "@boilerhouse/db";
import type { DrizzleDb, ActivityLog } from "@boilerhouse/db";
import { forceInstanceStatus, forceTenantStatus } from "./transitions";

export interface RecoveryReport {
	/** Instances confirmed alive in the runtime. */
	recovered: number;
	/** DB rows marked destroyed (instance gone from runtime). */
	destroyed: number;
	/** Tenants reset from intermediate states (claiming/releasing). */
	tenantsReset: number;
}

/** Statuses that indicate an instance should be running in the runtime. */
const LIVE_STATUSES: InstanceStatus[] = ["active", "starting"];

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
		tenantsReset: 0,
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
			// Instance is gone — mark destroyed
			forceInstanceStatus(db, row.instanceId, "destroyed");

			// Clear tenant's instanceId if assigned
			if (row.tenantId) {
				db.update(tenants)
					.set({ instanceId: null })
					.where(eq(tenants.tenantId, row.tenantId))
					.run();
			}

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

	// 3b. Recover instances stuck in "destroying" — cleanup already happened or failed
	const destroyingInstances = db
		.select()
		.from(instances)
		.where(eq(instances.nodeId, nodeId))
		.all()
		.filter((row) => row.status === "destroying");

	for (const row of destroyingInstances) {
		forceInstanceStatus(db, row.instanceId, "destroyed");

		activityLog.log({
			instanceId: row.instanceId,
			workloadId: row.workloadId,
			nodeId,
			event: "recovery.destroyed",
			metadata: { previousStatus: "destroying" },
		});

		report.destroyed++;
	}

	// 3c. Recover tenants stuck in intermediate states
	const stuckTenants = db
		.select()
		.from(tenants)
		.all()
		.filter((row) =>
			row.status === "claiming" || row.status === "releasing",
		);

	for (const row of stuckTenants) {
		if (row.status === "claiming") {
			// Claim never completed — reset to idle and clear instanceId
			forceTenantStatus(db, row.tenantId, "idle");
			db.update(tenants)
				.set({ instanceId: null })
				.where(eq(tenants.tenantId, row.tenantId))
				.run();
		} else if (row.status === "releasing") {
			// Check if the instance is still active
			const instanceActive = row.instanceId
				? db.select({ status: instances.status })
						.from(instances)
						.where(eq(instances.instanceId, row.instanceId))
						.get()
				: null;

			if (instanceActive && LIVE_STATUSES.includes(instanceActive.status!)) {
				// Instance still alive — release didn't complete, revert to active
				forceTenantStatus(db, row.tenantId, "active" as TenantStatus);
			} else {
				// Instance destroyed/missing — reset to idle and clear instanceId
				forceTenantStatus(db, row.tenantId, "idle");
				db.update(tenants)
					.set({ instanceId: null })
					.where(eq(tenants.tenantId, row.tenantId))
					.run();
			}
		}

		activityLog.log({
			tenantId: row.tenantId,
			workloadId: row.workloadId,
			nodeId,
			event: "recovery.tenant_reset",
			metadata: { previousStatus: row.status },
		});

		report.tenantsReset++;
	}

	return report;
}
