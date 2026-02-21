import { describe, test, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import {
	type TenantId,
	type WorkloadId,
	type NodeId,
	type TenantStatus,
	InvalidTransitionError,
	generateTenantId,
	generateWorkloadId,
	generateNodeId,
} from "@boilerhouse/core";
import {
	createTestDatabase,
	type DrizzleDb,
	tenants,
	nodes,
	workloads,
} from "@boilerhouse/db";
import { TenantActor } from "./tenant-actor";

let db: DrizzleDb;
let nodeId: NodeId;
let workloadId: WorkloadId;

function seedTenant(
	overrides: Partial<{ tenantId: TenantId; status: TenantStatus }> = {},
): TenantId {
	const id = overrides.tenantId ?? generateTenantId();
	db.insert(tenants)
		.values({
			tenantId: id,
			workloadId,
			status: overrides.status ?? "idle",
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

describe("TenantActor", () => {
	describe("status", () => {
		test("reads current status from DB", () => {
			const id = seedTenant({ status: "active" });
			const actor = new TenantActor(db, id);
			expect(actor.status).toBe("active");
		});

		test("throws if tenant does not exist", () => {
			const id = generateTenantId();
			const actor = new TenantActor(db, id);
			expect(() => actor.status).toThrow("not found");
		});
	});

	describe("send()", () => {
		test("transitions idle → claiming via 'claim'", () => {
			const id = seedTenant({ status: "idle" });
			const actor = new TenantActor(db, id);

			const next = actor.send("claim");

			expect(next).toBe("claiming");
			const row = db
				.select()
				.from(tenants)
				.where(eq(tenants.tenantId, id))
				.get();
			expect(row!.status).toBe("claiming");
		});

		test("transitions claiming → active via 'claimed'", () => {
			const id = seedTenant({ status: "claiming" });
			const actor = new TenantActor(db, id);

			const next = actor.send("claimed");

			expect(next).toBe("active");
		});

		test("transitions active → releasing via 'release'", () => {
			const id = seedTenant({ status: "active" });
			const actor = new TenantActor(db, id);

			const next = actor.send("release");

			expect(next).toBe("releasing");
		});

		test("transitions releasing → released via 'hibernated'", () => {
			const id = seedTenant({ status: "releasing" });
			const actor = new TenantActor(db, id);

			const next = actor.send("hibernated");

			expect(next).toBe("released");
		});

		test("transitions releasing → idle via 'destroyed'", () => {
			const id = seedTenant({ status: "releasing" });
			const actor = new TenantActor(db, id);

			const next = actor.send("destroyed");

			expect(next).toBe("idle");
		});

		test("transitions released → claiming via 'claim'", () => {
			const id = seedTenant({ status: "released" });
			const actor = new TenantActor(db, id);

			const next = actor.send("claim");

			expect(next).toBe("claiming");
		});

		test("throws InvalidTransitionError for invalid event", () => {
			const id = seedTenant({ status: "active" });
			const actor = new TenantActor(db, id);

			expect(() => actor.send("claimed")).toThrow(InvalidTransitionError);
		});

		test("throws if tenant does not exist", () => {
			const id = generateTenantId();
			const actor = new TenantActor(db, id);

			expect(() => actor.send("claim")).toThrow("not found");
		});
	});

	describe("validate()", () => {
		test("returns the next status without writing to DB", () => {
			const id = seedTenant({ status: "active" });
			const actor = new TenantActor(db, id);

			const next = actor.validate("release");

			expect(next).toBe("releasing");
			const row = db
				.select()
				.from(tenants)
				.where(eq(tenants.tenantId, id))
				.get();
			expect(row!.status).toBe("active");
		});

		test("throws InvalidTransitionError for invalid event", () => {
			const id = seedTenant({ status: "idle" });
			const actor = new TenantActor(db, id);

			expect(() => actor.validate("release")).toThrow(
				InvalidTransitionError,
			);
		});
	});

	describe("forceStatus()", () => {
		test("bypasses the state machine and writes directly", () => {
			const id = seedTenant({ status: "idle" });
			const actor = new TenantActor(db, id);

			actor.forceStatus("active");

			const row = db
				.select()
				.from(tenants)
				.where(eq(tenants.tenantId, id))
				.get();
			expect(row!.status).toBe("active");
		});
	});
});
