import { eq, and, inArray } from "drizzle-orm";
import { validateWorkload, generateWorkloadId } from "@boilerhouse/core";
import type { WorkloadId } from "@boilerhouse/core";
import type { DrizzleDb } from "@boilerhouse/db";
import { workloads, claims } from "@boilerhouse/db";
import type {
  BoilerhouseWorkload,
  BoilerhouseWorkloadStatus,
} from "./crd-types";
import { crdToWorkload } from "./converters";

export interface WorkloadControllerDeps {
  db: DrizzleDb;
}

/**
 * Reconciles a BoilerhouseWorkload CRD into the internal workloads table.
 * Converts CRD spec → internal Workload, validates, and upserts the DB row.
 */
export async function reconcileWorkload(
  crd: BoilerhouseWorkload,
  deps: WorkloadControllerDeps,
): Promise<BoilerhouseWorkloadStatus> {
  const name = crd.metadata.name;

  try {
    // 0. Deletion: check for active claims, then remove from DB
    if (crd.metadata.deletionTimestamp) {
      const existing = deps.db
        .select()
        .from(workloads)
        .where(eq(workloads.name, name))
        .get();

      if (existing) {
        const activeClaims = deps.db
          .select()
          .from(claims)
          .where(
            and(
              eq(claims.workloadId, existing.workloadId),
              inArray(claims.status, ["active", "creating"]),
            ),
          )
          .all();

        if (activeClaims.length > 0) {
          return {
            phase: "Error",
            detail: `Cannot delete: ${activeClaims.length} active claim(s) exist`,
            observedGeneration: crd.metadata.generation,
          };
        }

        deps.db
          .delete(workloads)
          .where(eq(workloads.workloadId, existing.workloadId))
          .run();
      }

      return {
        phase: "Ready",
        observedGeneration: crd.metadata.generation,
      };
    }

    // 1. Convert CRD spec → internal Workload shape
    const internal = crdToWorkload(name, crd.spec);

    // 2. Validate against WorkloadSchema (throws WorkloadParseError on failure)
    validateWorkload(internal);

    // 3. Upsert workload row
    const existing = deps.db
      .select()
      .from(workloads)
      .where(eq(workloads.name, name))
      .get();

    const now = new Date();
    const version = crd.spec.version;

    if (existing) {
      deps.db
        .update(workloads)
        .set({
          version,
          config: internal,
          updatedAt: now,
        })
        .where(eq(workloads.workloadId, existing.workloadId))
        .run();
    } else {
      const workloadId = generateWorkloadId();
      deps.db
        .insert(workloads)
        .values({
          workloadId,
          name,
          version,
          config: internal,
          status: "ready",
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }

    return {
      phase: "Ready",
      observedGeneration: crd.metadata.generation,
    };
  } catch (err) {
    return {
      phase: "Error",
      detail: err instanceof Error ? err.message : String(err),
      observedGeneration: crd.metadata.generation,
    };
  }
}
