import { eq } from "drizzle-orm";
import type { DrizzleDb } from "@boilerhouse/db";
import { workloads } from "@boilerhouse/db";
import type { WorkloadId } from "@boilerhouse/core";

/** Minimal pool manager interface needed for pre-warming. */
interface PoolManagerLike {
	replenish(workloadId: WorkloadId): Promise<void>;
	prime(workloadId: WorkloadId): Promise<void>;
}

/**
 * Fire-and-forget pre-warming of pools for all workloads that need it at startup.
 *
 * - `"ready"` workloads: calls `replenish()` to fill the pool to target size.
 * - `"creating"` workloads: calls `prime()` to complete the initial pool warm.
 * - All other statuses are skipped.
 */
export function prewarmPools(db: DrizzleDb, poolManager: PoolManagerLike): void {
	const allWorkloads = db.select().from(workloads).all();
	for (const row of allWorkloads) {
		if (row.status === "ready") {
			poolManager.replenish(row.workloadId).catch(() => {});
		} else if (row.status === "creating") {
			poolManager.prime(row.workloadId).catch((err: unknown) => {
				const message = err instanceof Error ? err.message : String(err);
				db.update(workloads)
					.set({ status: "error", statusDetail: message, updatedAt: new Date() })
					.where(eq(workloads.workloadId, row.workloadId))
					.run();
			});
		}
	}
}
