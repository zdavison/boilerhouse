import { describe, test, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import {
	type InstanceId,
	type InstanceStatus,
	type WorkloadId,
	type NodeId,
	type ClaimId,
	type ClaimStatus,
	type SnapshotId,
	type SnapshotStatus,
	type Workload,
	InvalidTransitionError,
	generateInstanceId,
	generateWorkloadId,
	generateNodeId,
	generateSnapshotId,
	generateClaimId,
} from "@boilerhouse/core";
import {
	createTestDatabase,
	type DrizzleDb,
	instances,
	nodes,
	workloads,
	tenants,
	claims,
	snapshots,
} from "@boilerhouse/db";
import type { TenantId } from "@boilerhouse/core";
import { generateTenantId } from "@boilerhouse/core";
import {
	applyInstanceTransition,
	applyClaimTransition,
	applySnapshotTransition,
	applyWorkloadTransition,
} from "./transitions";

let db: DrizzleDb;
let nodeId: NodeId;
let workloadId: WorkloadId;

function seedInstance(
	overrides: Partial<{ instanceId: InstanceId; status: InstanceStatus }> = {},
): InstanceId {
	const id = overrides.instanceId ?? generateInstanceId();
	db.insert(instances)
		.values({
			instanceId: id,
			workloadId,
			nodeId,
			status: overrides.status ?? "starting",
			createdAt: new Date(),
		})
		.run();
	return id;
}

function seedTenant(): TenantId {
	const id = generateTenantId();
	db.insert(tenants)
		.values({
			tenantId: id,
			workloadId,
			createdAt: new Date(),
		})
		.run();
	return id;
}

function seedClaim(status: ClaimStatus = "creating"): ClaimId {
	const tid = seedTenant();
	const id = generateClaimId();
	db.insert(claims)
		.values({
			claimId: id,
			tenantId: tid,
			workloadId,
			status,
			createdAt: new Date(),
		})
		.run();
	return id;
}

function seedSnapshot(status: SnapshotStatus = "creating"): SnapshotId {
	const id = generateSnapshotId();
	db.insert(snapshots)
		.values({
			snapshotId: id,
			type: "golden",
			status,
			instanceId: seedInstance({ status: "active" }),
			workloadId,
			nodeId,
			vmstatePath: "/tmp/vmstate",
			sizeBytes: 0,
			runtimeMeta: {},
			createdAt: new Date(),
		})
		.run();
	return id;
}

function getInstanceStatus(id: InstanceId): string {
	return db.select({ status: instances.status }).from(instances).where(eq(instances.instanceId, id)).get()!.status;
}

function getClaimStatus(id: ClaimId): string {
	return db.select({ status: claims.status }).from(claims).where(eq(claims.claimId, id)).get()!.status;
}

function getSnapshotStatus(id: SnapshotId): string {
	return db.select({ status: snapshots.status }).from(snapshots).where(eq(snapshots.snapshotId, id)).get()!.status;
}

function getWorkloadStatus(id: WorkloadId): string {
	return db.select({ status: workloads.status }).from(workloads).where(eq(workloads.workloadId, id)).get()!.status;
}

beforeEach(() => {
	db = createTestDatabase();
	nodeId = generateNodeId();
	workloadId = generateWorkloadId();

	db.insert(nodes)
		.values({
			nodeId,
			runtimeType: "podman",
			capacity: { vcpus: 4, memoryMb: 8192, diskGb: 50 },
			status: "online",
			lastHeartbeat: new Date(),
			createdAt: new Date(),
		})
		.run();

	db.insert(workloads)
		.values({
			workloadId,
			name: "test-workload",
			version: "1.0.0",
			status: "creating",
			config: {
				workload: { name: "test-workload", version: "1.0.0" },
				image: { ref: "test:latest" },
				resources: { vcpus: 1, memory_mb: 256, disk_gb: 2 },
				network: { access: "none" },
				idle: { action: "hibernate" },
			} as Workload,
			createdAt: new Date(),
			updatedAt: new Date(),
		})
		.run();
});

describe("applyInstanceTransition", () => {
	test("transitions starting → active on 'started'", () => {
		const id = seedInstance({ status: "starting" });
		const next = applyInstanceTransition(db, id, "starting", "started");
		expect(next).toBe("active");
		expect(getInstanceStatus(id)).toBe("active");
	});

	test("transitions active → hibernating on 'hibernate'", () => {
		const id = seedInstance({ status: "active" });
		const next = applyInstanceTransition(db, id, "active", "hibernate");
		expect(next).toBe("hibernating");
		expect(getInstanceStatus(id)).toBe("hibernating");
	});

	test("transitions hibernating → hibernated on 'hibernated'", () => {
		const id = seedInstance({ status: "hibernating" as any });
		const next = applyInstanceTransition(db, id, "hibernating", "hibernated");
		expect(next).toBe("hibernated");
		expect(getInstanceStatus(id)).toBe("hibernated");
	});

	test("transitions starting → restoring on 'restoring'", () => {
		const id = seedInstance({ status: "starting" });
		const next = applyInstanceTransition(db, id, "starting", "restoring");
		expect(next).toBe("restoring");
		expect(getInstanceStatus(id)).toBe("restoring");
	});

	test("transitions restoring → active on 'restored'", () => {
		const id = seedInstance({ status: "restoring" as any });
		const next = applyInstanceTransition(db, id, "restoring", "restored");
		expect(next).toBe("active");
		expect(getInstanceStatus(id)).toBe("active");
	});

	test("transitions hibernating → destroying on 'hibernating_failed'", () => {
		const id = seedInstance({ status: "hibernating" as any });
		const next = applyInstanceTransition(db, id, "hibernating", "hibernating_failed");
		expect(next).toBe("destroying");
		expect(getInstanceStatus(id)).toBe("destroying");
	});

	test("transitions hibernated → restoring on 'restoring'", () => {
		const id = seedInstance({ status: "hibernated" as any });
		const next = applyInstanceTransition(db, id, "hibernated", "restoring");
		expect(next).toBe("restoring");
		expect(getInstanceStatus(id)).toBe("restoring");
	});

	test("transitions active → destroying on 'destroy'", () => {
		const id = seedInstance({ status: "active" });
		const next = applyInstanceTransition(db, id, "active", "destroy");
		expect(next).toBe("destroying");
		expect(getInstanceStatus(id)).toBe("destroying");
	});

	test("transitions destroying → destroyed on 'destroyed'", () => {
		const id = seedInstance({ status: "destroying" });
		const next = applyInstanceTransition(db, id, "destroying", "destroyed");
		expect(next).toBe("destroyed");
		expect(getInstanceStatus(id)).toBe("destroyed");
	});

	test("throws InvalidTransitionError for invalid transition", () => {
		const id = seedInstance({ status: "destroyed" });
		expect(() =>
			applyInstanceTransition(db, id, "destroyed", "started"),
		).toThrow(InvalidTransitionError);
	});
});

describe("applyInstanceTransition (recover)", () => {
	test("transitions starting → destroyed on 'recover'", () => {
		const id = seedInstance({ status: "starting" });
		const next = applyInstanceTransition(db, id, "starting", "recover");
		expect(next).toBe("destroyed");
		expect(getInstanceStatus(id)).toBe("destroyed");
	});

	test("transitions active → destroyed on 'recover'", () => {
		const id = seedInstance({ status: "active" });
		const next = applyInstanceTransition(db, id, "active", "recover");
		expect(next).toBe("destroyed");
		expect(getInstanceStatus(id)).toBe("destroyed");
	});
});

describe("applyClaimTransition", () => {
	test("transitions creating → active on 'created'", () => {
		const id = seedClaim("creating");
		const next = applyClaimTransition(db, id, "creating", "created");
		expect(next).toBe("active");
		expect(getClaimStatus(id)).toBe("active");
	});

	test("transitions active → releasing on 'release'", () => {
		const id = seedClaim("active");
		const next = applyClaimTransition(db, id, "active", "release");
		expect(next).toBe("releasing");
		expect(getClaimStatus(id)).toBe("releasing");
	});

	test("transitions releasing → active on 'recover'", () => {
		const id = seedClaim("releasing");
		const next = applyClaimTransition(db, id, "releasing", "recover");
		expect(next).toBe("active");
		expect(getClaimStatus(id)).toBe("active");
	});

	test("throws InvalidTransitionError for invalid transition", () => {
		const id = seedClaim("creating");
		expect(() =>
			applyClaimTransition(db, id, "creating", "release"),
		).toThrow(InvalidTransitionError);
	});
});

describe("applyClaimTransition (recover)", () => {
	test("transitions releasing → active on 'recover'", () => {
		const id = seedClaim("releasing");
		const next = applyClaimTransition(db, id, "releasing", "recover");
		expect(next).toBe("active");
		expect(getClaimStatus(id)).toBe("active");
	});
});

describe("applySnapshotTransition", () => {
	test("transitions creating → ready on 'created'", () => {
		const id = seedSnapshot("creating");
		const next = applySnapshotTransition(db, id, "creating", "created");
		expect(next).toBe("ready");
		expect(getSnapshotStatus(id)).toBe("ready");
	});

	test("transitions creating → deleted on 'failed'", () => {
		const id = seedSnapshot("creating");
		const next = applySnapshotTransition(db, id, "creating", "failed");
		expect(next).toBe("deleted");
		expect(getSnapshotStatus(id)).toBe("deleted");
	});

	test("throws InvalidTransitionError for invalid transition", () => {
		const id = seedSnapshot("deleted");
		expect(() =>
			applySnapshotTransition(db, id, "deleted", "created"),
		).toThrow(InvalidTransitionError);
	});
});

describe("applyWorkloadTransition", () => {
	test("transitions creating → ready on 'created'", () => {
		const next = applyWorkloadTransition(db, workloadId, "creating", "created");
		expect(next).toBe("ready");
		expect(getWorkloadStatus(workloadId)).toBe("ready");
	});

	test("transitions creating → error on 'failed'", () => {
		const next = applyWorkloadTransition(db, workloadId, "creating", "failed");
		expect(next).toBe("error");
		expect(getWorkloadStatus(workloadId)).toBe("error");
	});

	test("transitions error → creating on 'retry'", () => {
		applyWorkloadTransition(db, workloadId, "creating", "failed");
		const next = applyWorkloadTransition(db, workloadId, "error", "retry");
		expect(next).toBe("creating");
		expect(getWorkloadStatus(workloadId)).toBe("creating");
	});

	test("throws InvalidTransitionError for invalid transition", () => {
		applyWorkloadTransition(db, workloadId, "creating", "created");
		expect(() =>
			applyWorkloadTransition(db, workloadId, "ready", "created"),
		).toThrow(InvalidTransitionError);
	});
});

describe("applyWorkloadTransition (recover)", () => {
	test("transitions ready → creating on 'recover'", () => {
		applyWorkloadTransition(db, workloadId, "creating", "created");
		const next = applyWorkloadTransition(db, workloadId, "ready", "recover");
		expect(next).toBe("creating");
		expect(getWorkloadStatus(workloadId)).toBe("creating");
	});
});
