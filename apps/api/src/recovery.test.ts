import { describe, test, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import {
	FakeRuntime,
	generateNodeId,
	generateInstanceId,
	generateWorkloadId,
	generateTenantId,
} from "@boilerhouse/core";
import type {
	NodeId,
	InstanceId,
	WorkloadId,
	TenantId,
	InstanceStatus,
} from "@boilerhouse/core";
import {
	createTestDatabase,
	ActivityLog,
	nodes,
	workloads,
	instances,
	tenants,
} from "@boilerhouse/db";
import type { DrizzleDb } from "@boilerhouse/db";
import { recoverState } from "./recovery";

// ── Helpers ─────────────────────────────────────────────────────────────────

let db: DrizzleDb;
let runtime: FakeRuntime;
let nodeId: NodeId;
let log: ActivityLog;
let workloadId: WorkloadId;

function insertWorkload(id: WorkloadId = workloadId): void {
	db.insert(workloads)
		.values({
			workloadId: id,
			name: `wk-${id.slice(0, 8)}`,
			version: "1.0.0",
			config: {
				workload: { name: `wk-${id.slice(0, 8)}`, version: "1.0.0" },
				image: { ref: "test:latest" },
				resources: { vcpus: 1, memory_mb: 256, disk_gb: 2 },
				network: { access: "none" },
				idle: { action: "hibernate" },
			},
			createdAt: new Date(),
			updatedAt: new Date(),
		})
		.run();
}

function insertInstance(
	instanceId: InstanceId,
	status: InstanceStatus,
	tenantId?: TenantId,
): void {
	db.insert(instances)
		.values({
			instanceId,
			workloadId,
			nodeId,
			tenantId: tenantId ?? null,
			status,
			createdAt: new Date(),
		})
		.run();
}

function insertTenant(tenantId: TenantId, instanceId: InstanceId | null): void {
	db.insert(tenants)
		.values({
			tenantId,
			workloadId,
			instanceId,
			createdAt: new Date(),
		})
		.run();
}

/** Add an instance to the fake runtime so it appears as "live". */
async function addToRuntime(instanceId: InstanceId): Promise<void> {
	const handle = await runtime.create(
		{
			workload: { name: "test", version: "1.0.0" },
			image: { ref: "test:latest" },
			resources: { vcpus: 1, memory_mb: 256, disk_gb: 2 },
			network: { access: "none" },
			idle: { action: "hibernate" },
		},
		instanceId,
	);
	await runtime.start(handle);
}

beforeEach(() => {
	db = createTestDatabase();
	runtime = new FakeRuntime();
	nodeId = generateNodeId();
	log = new ActivityLog(db);
	workloadId = generateWorkloadId();

	// Insert node + workload so FK constraints pass
	db.insert(nodes)
		.values({
			nodeId,
			runtimeType: "firecracker",
			capacity: { vcpus: 8, memoryMb: 16384, diskGb: 100 },
			status: "online",
			lastHeartbeat: new Date(),
			createdAt: new Date(),
		})
		.run();
	insertWorkload();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe("recoverState", () => {
	test("recovers instances still running in runtime", async () => {
		const id = generateInstanceId();
		insertInstance(id, "active");
		await addToRuntime(id);

		const report = await recoverState(runtime, db, nodeId, log);

		expect(report.recovered).toBe(1);
		expect(report.destroyed).toBe(0);

		// DB status unchanged
		const row = db.select().from(instances).where(eq(instances.instanceId, id)).get();
		expect(row!.status).toBe("active");
	});

	test("marks missing VMs as destroyed", async () => {
		const id = generateInstanceId();
		insertInstance(id, "active");
		// Not adding to runtime — VM is gone

		const report = await recoverState(runtime, db, nodeId, log);

		expect(report.destroyed).toBe(1);
		expect(report.recovered).toBe(0);

		const row = db.select().from(instances).where(eq(instances.instanceId, id)).get();
		expect(row!.status).toBe("destroyed");
	});

	test("handles status='starting' instances with no VM", async () => {
		const id = generateInstanceId();
		insertInstance(id, "starting");

		const report = await recoverState(runtime, db, nodeId, log);

		expect(report.destroyed).toBe(1);
		const row = db.select().from(instances).where(eq(instances.instanceId, id)).get();
		expect(row!.status).toBe("destroyed");
	});

	test("clears tenants.instanceId when VM is gone", async () => {
		const instanceId = generateInstanceId();
		const tenantId = generateTenantId();
		insertTenant(tenantId, instanceId);
		insertInstance(instanceId, "active", tenantId);

		const report = await recoverState(runtime, db, nodeId, log);

		expect(report.destroyed).toBe(1);

		const tenantRow = db.select().from(tenants).where(eq(tenants.tenantId, tenantId)).get();
		expect(tenantRow!.instanceId).toBeNull();
	});

	test("does not touch hibernated/destroyed instances", async () => {
		const hibernated = generateInstanceId();
		const destroyed = generateInstanceId();
		insertInstance(hibernated, "hibernated");
		insertInstance(destroyed, "destroyed");

		const report = await recoverState(runtime, db, nodeId, log);

		expect(report.recovered).toBe(0);
		expect(report.destroyed).toBe(0);

		const hRow = db.select().from(instances).where(eq(instances.instanceId, hibernated)).get();
		expect(hRow!.status).toBe("hibernated");

		const dRow = db.select().from(instances).where(eq(instances.instanceId, destroyed)).get();
		expect(dRow!.status).toBe("destroyed");
	});

	test("orphaned TAP devices are cleaned up", async () => {
		const liveId = generateInstanceId();
		insertInstance(liveId, "active");
		await addToRuntime(liveId);

		// Simulate orphaned TAP: a device name that doesn't match any active instance
		const destroyedTaps: string[] = [];

		const report = await recoverState(runtime, db, nodeId, log, {
			listTaps: async () => ["tap-deadbeef", "tap-00000000"],
			destroyTap: async (name) => {
				destroyedTaps.push(name);
			},
		});

		expect(report.orphanedTapsCleaned).toBe(2);
		expect(destroyedTaps).toContain("tap-deadbeef");
		expect(destroyedTaps).toContain("tap-00000000");
	});

	test("idempotent — second run returns {0, 0, 0}", async () => {
		const id = generateInstanceId();
		insertInstance(id, "active");
		// No VM — will be destroyed on first run

		await recoverState(runtime, db, nodeId, log);
		const report = await recoverState(runtime, db, nodeId, log);

		expect(report.recovered).toBe(0);
		expect(report.destroyed).toBe(0);
		expect(report.orphanedTapsCleaned).toBe(0);
	});

	test("logs activity for each destroyed instance", async () => {
		const id1 = generateInstanceId();
		const id2 = generateInstanceId();
		insertInstance(id1, "active");
		insertInstance(id2, "active");
		// Neither in runtime

		await recoverState(runtime, db, nodeId, log);

		const logs1 = log.queryByInstance(id1);
		expect(logs1.length).toBe(1);
		expect(logs1[0]!.event).toBe("recovery.destroyed");

		const logs2 = log.queryByInstance(id2);
		expect(logs2.length).toBe(1);
		expect(logs2[0]!.event).toBe("recovery.destroyed");
	});
});
