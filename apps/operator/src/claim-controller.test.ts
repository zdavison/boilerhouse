import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  generateWorkloadId,
  generateNodeId,
  generateTenantId,
  FakeRuntime,
} from "@boilerhouse/core";
import type { WorkloadId, NodeId, Workload } from "@boilerhouse/core";
import {
  createTestDatabase,
  type DrizzleDb,
  workloads,
  nodes,
} from "@boilerhouse/db";
import {
  InstanceManager,
  TenantDataStore,
  TenantManager,
  createTestAudit,
} from "@boilerhouse/domain";
import type { BoilerhouseClaim } from "./crd-types";
import { reconcileClaim } from "./claim-controller";

const API_VERSION = "boilerhouse.dev/v1alpha1" as const;

const TEST_WORKLOAD: Workload = {
  workload: { name: "test", version: "1.0.0" },
  image: { ref: "test:latest" },
  resources: { vcpus: 1, memory_mb: 256, disk_gb: 2 },
  network: { access: "none" },
  idle: { action: "hibernate" },
};

function makeClaimCrd(
  tenantId: string,
  workloadRef: string,
  overrides?: {
    status?: BoilerhouseClaim["status"];
    deletionTimestamp?: string;
    resume?: boolean;
  },
): BoilerhouseClaim {
  return {
    apiVersion: API_VERSION,
    kind: "BoilerhouseClaim",
    metadata: {
      name: `claim-${tenantId}`,
      namespace: "default",
      generation: 1,
      deletionTimestamp: overrides?.deletionTimestamp,
    },
    spec: {
      tenantId,
      workloadRef,
      resume: overrides?.resume,
    },
    status: overrides?.status,
  };
}

let db: DrizzleDb;
let tenantManager: TenantManager;
let workloadId: WorkloadId;
let nodeId: NodeId;

beforeEach(() => {
  db = createTestDatabase();
  const runtime = new FakeRuntime();
  nodeId = generateNodeId();
  workloadId = generateWorkloadId();
  const storagePath = mkdtempSync(join(tmpdir(), "claim-ctrl-test-"));

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

  db.insert(workloads)
    .values({
      workloadId,
      name: "test",
      version: "1.0.0",
      config: TEST_WORKLOAD,
      status: "ready",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();

  const audit = createTestAudit(db, nodeId);
  const instanceManager = new InstanceManager(runtime, db, audit, nodeId);
  const tenantDataStore = new TenantDataStore(storagePath, db, runtime);
  tenantManager = new TenantManager(instanceManager, db, audit, nodeId, tenantDataStore);
});

describe("reconcileClaim", () => {
  test("new claim gets instance, returns phase=Active", async () => {
    const tenantId = generateTenantId();
    const crd = makeClaimCrd(tenantId, "test");

    const status = await reconcileClaim(crd, { db, tenantManager });

    expect(status.phase).toBe("Active");
    expect(status.instanceId).toBeTruthy();
    expect(status.source).toBe("cold");
    expect(status.claimedAt).toBeTruthy();
  });

  test("missing workload returns phase=Error", async () => {
    const tenantId = generateTenantId();
    const crd = makeClaimCrd(tenantId, "nonexistent");

    const status = await reconcileClaim(crd, { db, tenantManager });

    expect(status.phase).toBe("Error");
    expect(status.detail).toContain("not found");
  });

  test("active claim is a no-op", async () => {
    const tenantId = generateTenantId();
    const existingStatus = {
      phase: "Active" as const,
      instanceId: "inst-123",
      claimedAt: "2024-01-01T00:00:00Z",
    };
    const crd = makeClaimCrd(tenantId, "test", { status: existingStatus });

    const status = await reconcileClaim(crd, { db, tenantManager });

    expect(status.phase).toBe("Active");
    expect(status.instanceId).toBe("inst-123");
  });

  test("deletion returns Released", async () => {
    const tenantId = generateTenantId();
    const crd = makeClaimCrd(tenantId, "test", {
      deletionTimestamp: new Date().toISOString(),
    });

    const status = await reconcileClaim(crd, { db, tenantManager });

    expect(status.phase).toBe("Released");
  });
});
