import { eq, and } from "drizzle-orm";
import type { WorkloadId } from "@boilerhouse/core";
import type { DrizzleDb } from "@boilerhouse/db";
import { workloads, instances } from "@boilerhouse/db";
import type { PoolManager } from "@boilerhouse/domain";
import type {
  BoilerhousePool,
  BoilerhousePoolStatus,
} from "@boilerhouse/runtime-kubernetes";

export interface PoolControllerDeps {
  db: DrizzleDb;
  poolManager: PoolManager;
}

/**
 * Reconciles a BoilerhousePool CRD.
 * Looks up the referenced workload, compares pool depth to target size,
 * and replenishes if needed.
 */
export async function reconcilePool(
  crd: BoilerhousePool,
  deps: PoolControllerDeps,
): Promise<BoilerhousePoolStatus> {
  const workloadName = crd.spec.workloadRef;
  const targetSize = crd.spec.size;

  try {
    // 0. Deletion: drain the pool and return
    if (crd.metadata.deletionTimestamp) {
      const workloadRow = deps.db
        .select()
        .from(workloads)
        .where(eq(workloads.name, workloadName))
        .get();

      if (workloadRow) {
        await deps.poolManager.drain(workloadRow.workloadId as WorkloadId);
      }

      return {
        phase: "Healthy",
        ready: 0,
        warming: 0,
      };
    }

    // 1. Look up referenced workload by name
    const workloadRow = deps.db
      .select()
      .from(workloads)
      .where(eq(workloads.name, workloadName))
      .get();

    if (!workloadRow) {
      return {
        phase: "Error",
        ready: 0,
        warming: 0,
        detail: `Workload "${workloadName}" not found`,
      };
    }

    if (workloadRow.status !== "ready" && workloadRow.status !== "created") {
      return {
        phase: "Degraded",
        ready: 0,
        warming: 0,
        detail: `Workload "${workloadName}" is in status "${workloadRow.status}"`,
      };
    }

    const workloadId = workloadRow.workloadId as WorkloadId;

    const countWarming = () =>
      deps.db
        .select({ instanceId: instances.instanceId })
        .from(instances)
        .where(and(eq(instances.workloadId, workloadId), eq(instances.poolStatus, "warming")))
        .all().length;

    // 2. Replenish if under target (getPoolDepth counts ready; replenish checks warming+ready)
    const readyCount = deps.poolManager.getPoolDepth(workloadId);
    const warmingCount = countWarming();
    if (readyCount + warmingCount < targetSize) {
      await deps.poolManager.replenish(workloadId);
    }

    return {
      phase: "Healthy",
      ready: deps.poolManager.getPoolDepth(workloadId),
      warming: countWarming(),
    };
  } catch (err) {
    return {
      phase: "Error",
      ready: 0,
      warming: 0,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
