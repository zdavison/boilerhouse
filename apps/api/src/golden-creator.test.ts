import { describe, test, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import {
	type WorkloadId,
	type NodeId,
	type Workload,
	generateWorkloadId,
	generateNodeId,
	FakeRuntime,
} from "@boilerhouse/core";
import {
	createTestDatabase,
	type DrizzleDb,
	workloads,
	nodes,
	snapshots,
} from "@boilerhouse/db";
import { SnapshotManager } from "./snapshot-manager";
import { EventBus, type DomainEvent } from "./event-bus";
import { GoldenCreator } from "./golden-creator";

const MINIMAL_WORKLOAD: Workload = {
	workload: { name: "test", version: "1.0.0" },
	image: { ref: "test:latest" },
	resources: { vcpus: 1, memory_mb: 256, disk_gb: 2 },
	network: { access: "none" },
	idle: { action: "hibernate" },
};

let db: DrizzleDb;
let nodeId: NodeId;
let snapshotManager: SnapshotManager;
let eventBus: EventBus;
let events: DomainEvent[];

function seedWorkload(overrides: { workloadId?: WorkloadId; name?: string; status?: string } = {}): WorkloadId {
	const id = overrides.workloadId ?? generateWorkloadId();
	db.insert(workloads)
		.values({
			workloadId: id,
			name: overrides.name ?? `test-${id}`,
			version: "1.0.0",
			status: (overrides.status ?? "creating") as "creating",
			config: MINIMAL_WORKLOAD,
			createdAt: new Date(),
			updatedAt: new Date(),
		})
		.run();
	return id;
}

beforeEach(() => {
	db = createTestDatabase();
	nodeId = generateNodeId();
	events = [];

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

	const runtime = new FakeRuntime();
	snapshotManager = new SnapshotManager(runtime, db, nodeId, {
		healthChecker: async () => {},
	});
	eventBus = new EventBus();
	eventBus.on((event) => events.push(event));
});

describe("GoldenCreator", () => {
	test("creates golden snapshot and transitions workload to ready", async () => {
		const creator = new GoldenCreator(db, snapshotManager, eventBus);
		const workloadId = seedWorkload();

		creator.enqueue(workloadId, MINIMAL_WORKLOAD);

		// Wait for processing to complete
		await waitForIdle(creator);

		const row = db
			.select()
			.from(workloads)
			.where(eq(workloads.workloadId, workloadId))
			.get();
		expect(row!.status).toBe("ready");

		const snapshotRows = db.select().from(snapshots).all();
		expect(snapshotRows.length).toBe(1);
		expect(snapshotRows[0]!.type).toBe("golden");

		expect(events).toHaveLength(1);
		expect(events[0]!.type).toBe("workload.state");
		if (events[0]!.type === "workload.state") {
			expect(events[0]!.status).toBe("ready");
			expect(events[0]!.workloadId).toBe(workloadId);
		}
	});

	test("processes multiple workloads sequentially", async () => {
		const creator = new GoldenCreator(db, snapshotManager, eventBus);
		const id1 = seedWorkload({ name: "app-one" });
		const id2 = seedWorkload({ name: "app-two" });

		creator.enqueue(id1, MINIMAL_WORKLOAD);
		creator.enqueue(id2, MINIMAL_WORKLOAD);

		await waitForIdle(creator);

		const r1 = db.select().from(workloads).where(eq(workloads.workloadId, id1)).get();
		const r2 = db.select().from(workloads).where(eq(workloads.workloadId, id2)).get();
		expect(r1!.status).toBe("ready");
		expect(r2!.status).toBe("ready");

		expect(events.filter((e) => e.type === "workload.state")).toHaveLength(2);
	});

	test("transitions workload to error on failure", async () => {
		const failingRuntime = new FakeRuntime();
		failingRuntime.create = () => {
			throw new Error("VM creation failed");
		};
		const failingSnapMgr = new SnapshotManager(failingRuntime, db, nodeId, {
			healthChecker: async () => {},
		});
		const creator = new GoldenCreator(db, failingSnapMgr, eventBus);
		const workloadId = seedWorkload();

		creator.enqueue(workloadId, MINIMAL_WORKLOAD);

		await waitForIdle(creator);

		const row = db
			.select()
			.from(workloads)
			.where(eq(workloads.workloadId, workloadId))
			.get();
		expect(row!.status).toBe("error");

		expect(events).toHaveLength(1);
		if (events[0]!.type === "workload.state") {
			expect(events[0]!.status).toBe("error");
		}
	});

	test("continues processing after a failure", async () => {
		let callCount = 0;
		const sometimesFailRuntime = new FakeRuntime();
		const origCreate = sometimesFailRuntime.create.bind(sometimesFailRuntime);
		sometimesFailRuntime.create = (...args: Parameters<typeof origCreate>) => {
			callCount++;
			if (callCount === 1) throw new Error("First one fails");
			return origCreate(...args);
		};
		const mixedSnapMgr = new SnapshotManager(sometimesFailRuntime, db, nodeId, {
			healthChecker: async () => {},
		});
		const creator = new GoldenCreator(db, mixedSnapMgr, eventBus);

		const id1 = seedWorkload({ name: "fail-app" });
		const id2 = seedWorkload({ name: "ok-app" });

		creator.enqueue(id1, MINIMAL_WORKLOAD);
		creator.enqueue(id2, MINIMAL_WORKLOAD);

		await waitForIdle(creator);

		const r1 = db.select().from(workloads).where(eq(workloads.workloadId, id1)).get();
		const r2 = db.select().from(workloads).where(eq(workloads.workloadId, id2)).get();
		expect(r1!.status).toBe("error");
		expect(r2!.status).toBe("ready");
	});

	test("pending and isProcessing reflect queue state", async () => {
		const creator = new GoldenCreator(db, snapshotManager, eventBus);

		expect(creator.pending).toBe(0);
		expect(creator.isProcessing).toBe(false);

		const workloadId = seedWorkload();
		creator.enqueue(workloadId, MINIMAL_WORKLOAD);

		// Processing starts immediately, so isProcessing should be true
		// (pending may be 0 because the item was shifted off)
		await waitForIdle(creator);

		expect(creator.pending).toBe(0);
		expect(creator.isProcessing).toBe(false);
	});
});

async function waitForIdle(creator: GoldenCreator, timeoutMs = 5000): Promise<void> {
	const start = Date.now();
	while (creator.isProcessing || creator.pending > 0) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("GoldenCreator did not become idle within timeout");
		}
		await new Promise((r) => setTimeout(r, 10));
	}
	// One extra tick to ensure final state writes complete
	await new Promise((r) => setTimeout(r, 10));
}
