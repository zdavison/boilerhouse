import { describe, test, expect, beforeEach } from "bun:test";
import { generateWorkloadId, FakeRuntime } from "@boilerhouse/core";
import type { WorkloadId, NodeId } from "@boilerhouse/core";
import {
  createTestDatabase,
  type DrizzleDb,
  workloads,
  nodes,
} from "@boilerhouse/db";
import { InstanceManager, PoolManager, createTestAudit } from "@boilerhouse/domain";
import { generateNodeId } from "@boilerhouse/core";
import type { BoilerhousePool } from "./crd-types";
import { reconcilePool } from "./pool-controller";

const API_VERSION = "boilerhouse.dev/v1alpha1" as const;

function makePoolCrd(workloadRef: string, size: number): BoilerhousePool {
  return {
    apiVersion: API_VERSION,
    kind: "BoilerhousePool",
    metadata: { name: `pool-${workloadRef}`, namespace: "default" },
    spec: { workloadRef, size },
  };
}

let db: DrizzleDb;
let runtime: FakeRuntime;
let poolManager: PoolManager;
let nodeId: NodeId;

beforeEach(() => {
  db = createTestDatabase();
  runtime = new FakeRuntime();
  nodeId = generateNodeId();

  db.insert(nodes)
    .values({
      nodeId,
      runtimeType: "podman",
      capacity: { vcpus: 8, memoryMb: 16384, diskGb: 100 },
      status: "online",
      lastHeartbeat: new Date(),
      createdAt: new Date(),
    })
    .run();

  const audit = createTestAudit(db, nodeId);
  const instanceManager = new InstanceManager(runtime, db, audit, nodeId);
  poolManager = new PoolManager(instanceManager, runtime, db);
});

describe("reconcilePool", () => {
  test("missing workload returns Error with detail", async () => {
    const crd = makePoolCrd("nonexistent", 3);

    const status = await reconcilePool(crd, { db, poolManager });

    expect(status.phase).toBe("Error");
    expect(status.ready).toBe(0);
    expect(status.detail).toContain("nonexistent");
  });

  test("existing workload returns Healthy", async () => {
    const workloadId = generateWorkloadId();
    db.insert(workloads)
      .values({
        workloadId,
        name: "my-pool-workload",
        version: "1.0.0",
        config: {
          workload: { name: "my-pool-workload", version: "1.0.0" },
          image: { ref: "test:latest" },
          resources: { vcpus: 1, memory_mb: 256, disk_gb: 2 },
          network: { access: "none" },
          idle: { action: "hibernate" },
        },
        status: "ready",
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();

    const crd = makePoolCrd("my-pool-workload", 1);
    const status = await reconcilePool(crd, { db, poolManager });

    expect(status.phase).toBe("Healthy");
  });
});
