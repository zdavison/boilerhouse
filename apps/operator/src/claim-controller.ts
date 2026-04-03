import { eq } from "drizzle-orm";
import type { WorkloadId, TenantId } from "@boilerhouse/core";
import type { DrizzleDb } from "@boilerhouse/db";
import { workloads } from "@boilerhouse/db";
import type { TenantManager } from "@boilerhouse/domain";
import type {
  BoilerhouseClaim,
  BoilerhouseClaimStatus,
} from "./crd-types";

export interface ClaimControllerDeps {
  db: DrizzleDb;
  tenantManager: TenantManager;
}

/**
 * Reconciles a BoilerhouseClaim CRD.
 * Handles new claims, deletions (release), active no-ops, and resume.
 */
export async function reconcileClaim(
  crd: BoilerhouseClaim,
  deps: ClaimControllerDeps,
): Promise<BoilerhouseClaimStatus> {
  const tenantId = crd.spec.tenantId as TenantId;
  const workloadName = crd.spec.workloadRef;
  const currentPhase = crd.status?.phase;

  try {
    // 1. Deletion: release tenant
    if (crd.metadata.deletionTimestamp) {
      const workloadRow = deps.db
        .select()
        .from(workloads)
        .where(eq(workloads.name, workloadName))
        .get();

      if (workloadRow) {
        await deps.tenantManager.release(
          tenantId,
          workloadRow.workloadId as WorkloadId,
        );
      }

      return { phase: "Released" };
    }

    // 2. Active: no-op
    if (currentPhase === "Active") {
      return crd.status!;
    }

    // 3. Released without resume: no-op
    if (currentPhase === "Released" && !crd.spec.resume) {
      return crd.status!;
    }

    // 4. Look up workload
    const workloadRow = deps.db
      .select()
      .from(workloads)
      .where(eq(workloads.name, workloadName))
      .get();

    if (!workloadRow) {
      return {
        phase: "Error",
        detail: `Workload '${workloadName}' not found`,
      };
    }

    const workloadId = workloadRow.workloadId as WorkloadId;

    // 5. Claim (new or resume)
    const result = await deps.tenantManager.claim(tenantId, workloadId);

    return {
      phase: "Active",
      instanceId: result.instanceId,
      endpoint: result.endpoint
        ? { host: result.endpoint.host, port: result.endpoint.ports[0] ?? 0 }
        : undefined,
      source: result.source,
      claimedAt: new Date().toISOString(),
    };
  } catch (err) {
    return {
      phase: "Error",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
