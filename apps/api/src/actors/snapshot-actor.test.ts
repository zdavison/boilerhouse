import { describe, test, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import {
	type SnapshotId,
	type InstanceId,
	type WorkloadId,
	type NodeId,
	type SnapshotStatus,
	InvalidTransitionError,
	generateSnapshotId,
	generateInstanceId,
	generateWorkloadId,
	generateNodeId,
} from "@boilerhouse/core";
import {
	createTestDatabase,
	type DrizzleDb,
	snapshots,
	nodes,
	workloads,
} from "@boilerhouse/db";
import { SnapshotActor } from "./snapshot-actor";

let db: DrizzleDb;
let nodeId: NodeId;
let workloadId: WorkloadId;

function seedSnapshot(
	overrides: Partial<{
		snapshotId: SnapshotId;
		status: SnapshotStatus;
		instanceId: InstanceId;
	}> = {},
): SnapshotId {
	const id = overrides.snapshotId ?? generateSnapshotId();
	db.insert(snapshots)
		.values({
			snapshotId: id,
			type: "tenant",
			status: overrides.status ?? "creating",
			instanceId: overrides.instanceId ?? generateInstanceId(),
			workloadId,
			nodeId,
			vmstatePath: "/fake/vmstate",
			memoryPath: "/fake/memory",
			sizeBytes: 0,
			createdAt: new Date(),
		})
		.run();
	return id;
}

beforeEach(() => {
	db = createTestDatabase();
	nodeId = generateNodeId();
	workloadId = generateWorkloadId();

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

	db.insert(workloads)
		.values({
			workloadId,
			name: "test",
			version: "1.0.0",
			config: {
				workload: { name: "test", version: "1.0.0" },
				image: { ref: "test:latest" },
				resources: { vcpus: 1, memory_mb: 256, disk_gb: 2 },
				network: { access: "none" },
				idle: { action: "hibernate" },
			},
			createdAt: new Date(),
			updatedAt: new Date(),
		})
		.run();
});

describe("SnapshotActor", () => {
	describe("status", () => {
		test("reads current status from DB", () => {
			const id = seedSnapshot({ status: "creating" });
			const actor = new SnapshotActor(db, id);
			expect(actor.status).toBe("creating");
		});

		test("throws if snapshot does not exist", () => {
			const id = generateSnapshotId();
			const actor = new SnapshotActor(db, id);
			expect(() => actor.status).toThrow("not found");
		});
	});

	describe("send()", () => {
		test("transitions creating → ready via 'created'", () => {
			const id = seedSnapshot({ status: "creating" });
			const actor = new SnapshotActor(db, id);

			const next = actor.send("created");

			expect(next).toBe("ready");
			const row = db
				.select()
				.from(snapshots)
				.where(eq(snapshots.snapshotId, id))
				.get();
			expect(row!.status).toBe("ready");
		});

		test("transitions creating → deleted via 'failed'", () => {
			const id = seedSnapshot({ status: "creating" });
			const actor = new SnapshotActor(db, id);

			const next = actor.send("failed");

			expect(next).toBe("deleted");
		});

		test("transitions ready → expired via 'expire'", () => {
			const id = seedSnapshot({ status: "ready" });
			const actor = new SnapshotActor(db, id);

			const next = actor.send("expire");

			expect(next).toBe("expired");
		});

		test("transitions ready → deleted via 'delete'", () => {
			const id = seedSnapshot({ status: "ready" });
			const actor = new SnapshotActor(db, id);

			const next = actor.send("delete");

			expect(next).toBe("deleted");
		});

		test("transitions expired → deleted via 'delete'", () => {
			const id = seedSnapshot({ status: "expired" });
			const actor = new SnapshotActor(db, id);

			const next = actor.send("delete");

			expect(next).toBe("deleted");
		});

		test("throws InvalidTransitionError for invalid event", () => {
			const id = seedSnapshot({ status: "deleted" });
			const actor = new SnapshotActor(db, id);

			expect(() => actor.send("created")).toThrow(InvalidTransitionError);
		});

		test("throws if snapshot does not exist", () => {
			const id = generateSnapshotId();
			const actor = new SnapshotActor(db, id);

			expect(() => actor.send("created")).toThrow("not found");
		});
	});

	describe("validate()", () => {
		test("returns the next status without writing to DB", () => {
			const id = seedSnapshot({ status: "creating" });
			const actor = new SnapshotActor(db, id);

			const next = actor.validate("created");

			expect(next).toBe("ready");
			const row = db
				.select()
				.from(snapshots)
				.where(eq(snapshots.snapshotId, id))
				.get();
			expect(row!.status).toBe("creating");
		});

		test("throws InvalidTransitionError for invalid event", () => {
			const id = seedSnapshot({ status: "deleted" });
			const actor = new SnapshotActor(db, id);

			expect(() => actor.validate("created")).toThrow(
				InvalidTransitionError,
			);
		});
	});

	describe("forceStatus()", () => {
		test("bypasses the state machine and writes directly", () => {
			const id = seedSnapshot({ status: "creating" });
			const actor = new SnapshotActor(db, id);

			actor.forceStatus("deleted");

			const row = db
				.select()
				.from(snapshots)
				.where(eq(snapshots.snapshotId, id))
				.get();
			expect(row!.status).toBe("deleted");
		});
	});
});
