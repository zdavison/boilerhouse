import { describe, test, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { createTestDatabase, type DrizzleDb, workloads } from "@boilerhouse/db";
import type { BoilerhouseWorkload } from "./crd-types";
import { reconcileWorkload } from "./workload-controller";

const API_VERSION = "boilerhouse.dev/v1alpha1" as const;

function makeCrd(
  name: string,
  spec: BoilerhouseWorkload["spec"],
  overrides?: Partial<BoilerhouseWorkload["metadata"]>,
): BoilerhouseWorkload {
  return {
    apiVersion: API_VERSION,
    kind: "BoilerhouseWorkload",
    metadata: { name, namespace: "default", generation: 1, ...overrides },
    spec,
  };
}

let db: DrizzleDb;

beforeEach(() => {
  db = createTestDatabase();
});

describe("reconcileWorkload", () => {
  test("new CRD creates workload row, returns phase=Ready", async () => {
    const crd = makeCrd("my-workload", {
      version: "1.0.0",
      image: { ref: "nginx:latest" },
      resources: { vcpus: 1, memoryMb: 256, diskGb: 2 },
    });

    const status = await reconcileWorkload(crd, { db });

    expect(status.phase).toBe("Ready");
    expect(status.observedGeneration).toBe(1);

    const row = db.select().from(workloads).where(eq(workloads.name, "my-workload")).get();
    expect(row).toBeDefined();
    expect(row!.name).toBe("my-workload");
    expect(row!.version).toBe("1.0.0");
    expect(row!.status).toBe("ready");
  });

  test("invalid spec returns phase=Error", async () => {
    const crd = makeCrd("bad-workload", {
      version: "1.0.0",
      // Missing image ref — image section requires either ref or dockerfile
      image: {} as any,
      resources: { vcpus: 1, memoryMb: 256, diskGb: 2 },
    });

    const status = await reconcileWorkload(crd, { db });

    expect(status.phase).toBe("Error");
    expect(status.detail).toBeTruthy();

    // No row should be created
    const row = db.select().from(workloads).where(eq(workloads.name, "bad-workload")).get();
    expect(row).toBeUndefined();
  });

  test("updating existing workload updates the row", async () => {
    const crd1 = makeCrd("up-workload", {
      version: "1.0.0",
      image: { ref: "nginx:1.0" },
      resources: { vcpus: 1, memoryMb: 256, diskGb: 2 },
    });

    await reconcileWorkload(crd1, { db });

    const crd2 = makeCrd("up-workload", {
      version: "2.0.0",
      image: { ref: "nginx:2.0" },
      resources: { vcpus: 2, memoryMb: 512, diskGb: 4 },
    }, { generation: 2 });

    const status = await reconcileWorkload(crd2, { db });

    expect(status.phase).toBe("Ready");
    expect(status.observedGeneration).toBe(2);

    const rows = db.select().from(workloads).where(eq(workloads.name, "up-workload")).all();
    expect(rows.length).toBe(1);
    expect(rows[0].version).toBe("2.0.0");
  });
});
