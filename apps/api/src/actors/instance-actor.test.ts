import { describe, test, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import {
	type InstanceId,
	type InstanceStatus,
	type WorkloadId,
	type NodeId,
	InvalidTransitionError,
	generateInstanceId,
	generateWorkloadId,
	generateNodeId,
} from "@boilerhouse/core";
import {
	createTestDatabase,
	type DrizzleDb,
	instances,
	nodes,
	workloads,
} from "@boilerhouse/db";
import { InstanceActor } from "./instance-actor";

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

describe("InstanceActor", () => {
	describe("status", () => {
		test("reads current status from DB", () => {
			const id = seedInstance({ status: "active" });
			const actor = new InstanceActor(db, id);
			expect(actor.status).toBe("active");
		});

		test("throws if instance does not exist", () => {
			const id = generateInstanceId();
			const actor = new InstanceActor(db, id);
			expect(() => actor.status).toThrow("not found");
		});
	});

	describe("send()", () => {
		test("transitions starting → active via 'started'", () => {
			const id = seedInstance({ status: "starting" });
			const actor = new InstanceActor(db, id);

			const next = actor.send("started");

			expect(next).toBe("active");
			const row = db
				.select()
				.from(instances)
				.where(eq(instances.instanceId, id))
				.get();
			expect(row!.status).toBe("active");
		});

		test("transitions active → destroying via 'destroy'", () => {
			const id = seedInstance({ status: "active" });
			const actor = new InstanceActor(db, id);

			const next = actor.send("destroy");

			expect(next).toBe("destroying");
			const row = db
				.select()
				.from(instances)
				.where(eq(instances.instanceId, id))
				.get();
			expect(row!.status).toBe("destroying");
		});

		test("transitions destroying → destroyed via 'destroyed'", () => {
			const id = seedInstance({ status: "destroying" });
			const actor = new InstanceActor(db, id);

			const next = actor.send("destroyed");

			expect(next).toBe("destroyed");
		});

		test("transitions active → stopping via 'stop'", () => {
			const id = seedInstance({ status: "active" });
			const actor = new InstanceActor(db, id);

			const next = actor.send("stop");

			expect(next).toBe("stopping");
		});

		test("transitions stopping → destroyed via 'stopped'", () => {
			const id = seedInstance({ status: "stopping" });
			const actor = new InstanceActor(db, id);

			const next = actor.send("stopped");

			expect(next).toBe("destroyed");
		});

		test("transitions active → hibernated via 'hibernate'", () => {
			const id = seedInstance({ status: "active" });
			const actor = new InstanceActor(db, id);

			const next = actor.send("hibernate");

			expect(next).toBe("hibernated");
			const row = db
				.select()
				.from(instances)
				.where(eq(instances.instanceId, id))
				.get();
			expect(row!.status).toBe("hibernated");
		});

		test("throws InvalidTransitionError for invalid event", () => {
			const id = seedInstance({ status: "destroyed" });
			const actor = new InstanceActor(db, id);

			expect(() => actor.send("started")).toThrow(InvalidTransitionError);
		});

		test("throws if instance does not exist", () => {
			const id = generateInstanceId();
			const actor = new InstanceActor(db, id);

			expect(() => actor.send("started")).toThrow("not found");
		});
	});

	describe("validate()", () => {
		test("returns the next status without writing to DB", () => {
			const id = seedInstance({ status: "active" });
			const actor = new InstanceActor(db, id);

			const next = actor.validate("hibernate");

			expect(next).toBe("hibernated");
			// DB should still show "active"
			const row = db
				.select()
				.from(instances)
				.where(eq(instances.instanceId, id))
				.get();
			expect(row!.status).toBe("active");
		});

		test("throws InvalidTransitionError for invalid event", () => {
			const id = seedInstance({ status: "destroyed" });
			const actor = new InstanceActor(db, id);

			expect(() => actor.validate("started")).toThrow(
				InvalidTransitionError,
			);
		});
	});

	describe("forceStatus()", () => {
		test("bypasses the state machine and writes directly", () => {
			const id = seedInstance({ status: "starting" });
			const actor = new InstanceActor(db, id);

			actor.forceStatus("destroyed");

			const row = db
				.select()
				.from(instances)
				.where(eq(instances.instanceId, id))
				.get();
			expect(row!.status).toBe("destroyed");
		});
	});
});
