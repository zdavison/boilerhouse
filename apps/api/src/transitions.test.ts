import { describe, test, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import {
	type InstanceId,
	type InstanceStatus,
	type WorkloadId,
	type NodeId,
	type TenantId,
	type TenantStatus,
	type SnapshotId,
	type SnapshotStatus,
	type Workload,
	InvalidTransitionError,
	generateInstanceId,
	generateWorkloadId,
	generateNodeId,
	generateSnapshotId,
} from "@boilerhouse/core";
import {
	createTestDatabase,
	type DrizzleDb,
	instances,
	nodes,
	workloads,
	tenants,
	snapshots,
} from "@boilerhouse/db";
import {
	applyInstanceTransition,
	forceInstanceStatus,
	applyTenantTransition,
	forceTenantStatus,
	applySnapshotTransition,
	applyWorkloadTransition,
	forceWorkloadStatus,
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

function seedTenant(status: TenantStatus = "idle"): TenantId {
	const id = `tenant-${Math.random().toString(36).slice(2, 8)}` as TenantId;
	db.insert(tenants)
		.values({
			tenantId: id,
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

function getTenantStatus(id: TenantId): string {
	return db.select({ status: tenants.status }).from(tenants).where(eq(tenants.tenantId, id)).get()!.status;
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
			runtimeType: "firecracker",
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

	test("transitions active → hibernated on 'hibernate'", () => {
		const id = seedInstance({ status: "active" });
		const next = applyInstanceTransition(db, id, "active", "hibernate");
		expect(next).toBe("hibernated");
		expect(getInstanceStatus(id)).toBe("hibernated");
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

describe("forceInstanceStatus", () => {
	test("writes status directly, bypassing state machine", () => {
		const id = seedInstance({ status: "starting" });
		forceInstanceStatus(db, id, "destroyed");
		expect(getInstanceStatus(id)).toBe("destroyed");
	});
});

describe("applyTenantTransition", () => {
	test("transitions idle → claiming on 'claim'", () => {
		const id = seedTenant("idle");
		const next = applyTenantTransition(db, id, "idle", "claim");
		expect(next).toBe("claiming");
		expect(getTenantStatus(id)).toBe("claiming");
	});

	test("transitions claiming → active on 'claimed'", () => {
		const id = seedTenant("claiming");
		const next = applyTenantTransition(db, id, "claiming", "claimed");
		expect(next).toBe("active");
		expect(getTenantStatus(id)).toBe("active");
	});

	test("transitions active → releasing on 'release'", () => {
		const id = seedTenant("active");
		const next = applyTenantTransition(db, id, "active", "release");
		expect(next).toBe("releasing");
		expect(getTenantStatus(id)).toBe("releasing");
	});

	test("throws InvalidTransitionError for invalid transition", () => {
		const id = seedTenant("idle");
		expect(() =>
			applyTenantTransition(db, id, "idle", "claimed"),
		).toThrow(InvalidTransitionError);
	});
});

describe("forceTenantStatus", () => {
	test("writes status directly, bypassing state machine", () => {
		const id = seedTenant("claiming");
		forceTenantStatus(db, id, "idle");
		expect(getTenantStatus(id)).toBe("idle");
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

describe("forceWorkloadStatus", () => {
	test("writes status directly, bypassing state machine", () => {
		forceWorkloadStatus(db, workloadId, "error");
		expect(getWorkloadStatus(workloadId)).toBe("error");
	});
});
