import { describe, test, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import {
	type WorkloadId,
	type WorkloadStatus,
	type NodeId,
	InvalidTransitionError,
	generateWorkloadId,
	generateNodeId,
} from "@boilerhouse/core";
import {
	createTestDatabase,
	type DrizzleDb,
	workloads,
	nodes,
} from "@boilerhouse/db";
import { WorkloadActor } from "./workload-actor";

let db: DrizzleDb;
let nodeId: NodeId;

function seedWorkload(
	overrides: Partial<{
		workloadId: WorkloadId;
		status: WorkloadStatus;
	}> = {},
): WorkloadId {
	const id = overrides.workloadId ?? generateWorkloadId();
	db.insert(workloads)
		.values({
			workloadId: id,
			name: `test-${id}`,
			version: "1.0.0",
			status: overrides.status ?? "creating",
			config: {
				workload: { name: `test-${id}`, version: "1.0.0" },
				image: { ref: "test:latest" },
				resources: { vcpus: 1, memory_mb: 256, disk_gb: 2 },
				network: { access: "none" },
				idle: { action: "hibernate" },
			},
			createdAt: new Date(),
			updatedAt: new Date(),
		})
		.run();
	return id;
}

beforeEach(() => {
	db = createTestDatabase();
	nodeId = generateNodeId();

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
});

describe("WorkloadActor", () => {
	describe("status", () => {
		test("reads current status from DB", () => {
			const id = seedWorkload({ status: "creating" });
			const actor = new WorkloadActor(db, id);
			expect(actor.status).toBe("creating");
		});

		test("throws if workload does not exist", () => {
			const id = generateWorkloadId();
			const actor = new WorkloadActor(db, id);
			expect(() => actor.status).toThrow("not found");
		});
	});

	describe("send()", () => {
		test("transitions creating → ready via 'created'", () => {
			const id = seedWorkload({ status: "creating" });
			const actor = new WorkloadActor(db, id);

			const next = actor.send("created");

			expect(next).toBe("ready");
			const row = db
				.select()
				.from(workloads)
				.where(eq(workloads.workloadId, id))
				.get();
			expect(row!.status).toBe("ready");
		});

		test("transitions creating → error via 'failed'", () => {
			const id = seedWorkload({ status: "creating" });
			const actor = new WorkloadActor(db, id);

			const next = actor.send("failed");

			expect(next).toBe("error");
		});

		test("transitions error → creating via 'retry'", () => {
			const id = seedWorkload({ status: "error" });
			const actor = new WorkloadActor(db, id);

			const next = actor.send("retry");

			expect(next).toBe("creating");
		});

		test("throws InvalidTransitionError for invalid event", () => {
			const id = seedWorkload({ status: "ready" });
			const actor = new WorkloadActor(db, id);

			expect(() => actor.send("created")).toThrow(InvalidTransitionError);
		});

		test("throws if workload does not exist", () => {
			const id = generateWorkloadId();
			const actor = new WorkloadActor(db, id);

			expect(() => actor.send("created")).toThrow("not found");
		});
	});

	describe("validate()", () => {
		test("returns the next status without writing to DB", () => {
			const id = seedWorkload({ status: "creating" });
			const actor = new WorkloadActor(db, id);

			const next = actor.validate("created");

			expect(next).toBe("ready");
			const row = db
				.select()
				.from(workloads)
				.where(eq(workloads.workloadId, id))
				.get();
			expect(row!.status).toBe("creating");
		});

		test("throws InvalidTransitionError for invalid event", () => {
			const id = seedWorkload({ status: "ready" });
			const actor = new WorkloadActor(db, id);

			expect(() => actor.validate("created")).toThrow(
				InvalidTransitionError,
			);
		});
	});

	describe("forceStatus()", () => {
		test("bypasses the state machine and writes directly", () => {
			const id = seedWorkload({ status: "creating" });
			const actor = new WorkloadActor(db, id);

			actor.forceStatus("error");

			const row = db
				.select()
				.from(workloads)
				.where(eq(workloads.workloadId, id))
				.get();
			expect(row!.status).toBe("error");
		});
	});
});
