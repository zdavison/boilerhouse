import { eq } from "drizzle-orm";
import type { Runtime, NodeId, InstanceId, InstanceStatus } from "@boilerhouse/core";
import { instances, tenants } from "@boilerhouse/db";
import type { DrizzleDb, ActivityLog } from "@boilerhouse/db";
import { TapManager } from "./network/tap";

export interface RecoveryReport {
	/** VMs confirmed alive in the runtime. */
	recovered: number;
	/** DB rows marked destroyed (VM gone from runtime). */
	destroyed: number;
	/** Orphaned TAP devices cleaned up. */
	orphanedTapsCleaned: number;
	/** Orphaned network namespaces cleaned up. */
	orphanedNetnsCleaned: number;
	/** Orphaned jail directories cleaned up. */
	orphanedJailsCleaned: number;
}

/** Lists TAP device names on the system. */
export type TapLister = () => Promise<string[]>;
/** Destroys a TAP device by name. */
export type TapDestroyer = (tapName: string) => Promise<void>;

export interface RecoveryOptions {
	listTaps?: TapLister;
	destroyTap?: TapDestroyer;
	/** Lists fc-* network namespaces on the system. */
	listNetns?: () => Promise<string[]>;
	/** Destroys a network namespace by name. */
	destroyNetns?: (nsName: string) => Promise<void>;
	/** Derives the expected namespace name from an instance ID. */
	deriveNsName?: (instanceId: InstanceId) => string;
	/** Lists jail instance IDs from directories under chrootBaseDir/firecracker/. */
	listJails?: (chrootBaseDir: string) => Promise<string[]>;
	/** Cleans up a jail directory for a given instanceId. */
	cleanJail?: (instanceId: string, chrootBaseDir: string) => Promise<void>;
	/** Base directory for chroot jails (required if listJails/cleanJail are set). */
	chrootBaseDir?: string;
}

/** Statuses that indicate a VM should be running in the runtime. */
const LIVE_STATUSES: InstanceStatus[] = ["active", "starting"];

/**
 * Reconciles DB state with the actual runtime after a server restart.
 *
 * Instances marked as active/starting in the DB but absent from the runtime
 * are transitioned to "destroyed". Orphaned TAP devices, network namespaces,
 * and jail directories are cleaned up.
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
	options?: RecoveryOptions,
): Promise<RecoveryReport> {
	const report: RecoveryReport = {
		recovered: 0,
		destroyed: 0,
		orphanedTapsCleaned: 0,
		orphanedNetnsCleaned: 0,
		orphanedJailsCleaned: 0,
	};

	// 1. Query instances that should have a live VM
	const dbInstances = db
		.select()
		.from(instances)
		.where(eq(instances.nodeId, nodeId))
		.all()
		.filter((row) => LIVE_STATUSES.includes(row.status!));

	const hasCleanupCallbacks =
		options?.listTaps ||
		options?.listNetns ||
		options?.listJails;

	if (dbInstances.length === 0 && !hasCleanupCallbacks) {
		return report;
	}

	// 2. Get live VM set from runtime
	const liveVMs = new Set<string>(await runtime.list());

	// 3. Reconcile each DB instance
	for (const row of dbInstances) {
		if (liveVMs.has(row.instanceId)) {
			report.recovered++;
		} else {
			// VM is gone — mark destroyed
			db.update(instances)
				.set({ status: "destroyed" as InstanceStatus })
				.where(eq(instances.instanceId, row.instanceId))
				.run();

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

	// Re-query active instances after reconciliation for cleanup checks
	const activeInstances = db
		.select()
		.from(instances)
		.where(eq(instances.nodeId, nodeId))
		.all()
		.filter((row) => LIVE_STATUSES.includes(row.status!));

	const activeInstanceIds = new Set<string>(
		activeInstances.map((row) => row.instanceId),
	);

	// 4. Clean up orphaned TAP devices
	if (options?.listTaps && options?.destroyTap) {
		const tapManager = new TapManager();
		const systemTaps = await options.listTaps();

		const expectedTapNames = new Set(
			activeInstances.map((row) => tapManager.getDeviceName(row.instanceId)),
		);

		for (const tapName of systemTaps) {
			if (!expectedTapNames.has(tapName)) {
				await options.destroyTap(tapName);
				report.orphanedTapsCleaned++;
			}
		}
	}

	// 5. Clean up orphaned network namespaces
	if (options?.listNetns && options?.destroyNetns && options?.deriveNsName) {
		const systemNetns = await options.listNetns();

		const expectedNsNames = new Set(
			activeInstances.map((row) => options.deriveNsName!(row.instanceId)),
		);

		for (const nsName of systemNetns) {
			if (!expectedNsNames.has(nsName)) {
				await options.destroyNetns(nsName);
				report.orphanedNetnsCleaned++;
			}
		}
	}

	// 6. Clean up orphaned jail directories
	if (options?.listJails && options?.cleanJail && options?.chrootBaseDir) {
		const jailInstanceIds = await options.listJails(options.chrootBaseDir);

		for (const jailInstanceId of jailInstanceIds) {
			if (!activeInstanceIds.has(jailInstanceId)) {
				await options.cleanJail(jailInstanceId, options.chrootBaseDir);
				report.orphanedJailsCleaned++;
			}
		}
	}

	return report;
}
