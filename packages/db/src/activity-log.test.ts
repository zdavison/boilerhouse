import { describe, test, expect, beforeEach } from "bun:test";
import { createTestDatabase, type DrizzleDb } from "./database";
import { activityLog } from "./schema";
import { ActivityLog } from "./activity-log";
import type { InstanceId, TenantId, WorkloadId, NodeId } from "@boilerhouse/core";

let db: DrizzleDb;

beforeEach(() => {
	db = createTestDatabase();
});

describe("ActivityLog", () => {
	describe("log()", () => {
		test("inserts an event with createdAt auto-populated", () => {
			const log = new ActivityLog(db);
			log.log({ event: "instance.started", instanceId: "inst-1" as InstanceId });

			const rows = db.select().from(activityLog).all();
			expect(rows).toHaveLength(1);
			expect(rows[0]!.event).toBe("instance.started");
			expect(rows[0]!.instanceId).toBe("inst-1" as InstanceId);
			expect(rows[0]!.createdAt).toBeInstanceOf(Date);
		});

		test("stores optional entity IDs", () => {
			const log = new ActivityLog(db);
			log.log({
				event: "tenant.claimed",
				instanceId: "inst-1" as InstanceId,
				workloadId: "wl-1" as WorkloadId,
				nodeId: "node-1" as NodeId,
				tenantId: "tenant-1" as TenantId,
			});

			const row = db.select().from(activityLog).get();
			expect(row!.workloadId).toBe("wl-1" as WorkloadId);
			expect(row!.nodeId).toBe("node-1" as NodeId);
			expect(row!.tenantId).toBe("tenant-1" as TenantId);
		});

		test("stores metadata", () => {
			const log = new ActivityLog(db);
			log.log({
				event: "instance.error",
				metadata: { reason: "OOM", exitCode: 137 },
			});

			const row = db.select().from(activityLog).get();
			expect(row!.metadata).toEqual({ reason: "OOM", exitCode: 137 });
		});

		test("prunes oldest events when maxEvents exceeded", () => {
			const log = new ActivityLog(db, 3);

			log.log({ event: "e1" });
			log.log({ event: "e2" });
			log.log({ event: "e3" });
			log.log({ event: "e4" });
			log.log({ event: "e5" });

			const rows = db.select().from(activityLog).all();
			expect(rows).toHaveLength(3);
			expect(rows.map((r) => r.event)).toEqual(["e3", "e4", "e5"]);
		});

		test("no pruning when maxEvents is not set (Infinity)", () => {
			const log = new ActivityLog(db);

			for (let i = 0; i < 10; i++) {
				log.log({ event: `e${i}` });
			}

			const rows = db.select().from(activityLog).all();
			expect(rows).toHaveLength(10);
		});
	});

	describe("queryByInstance()", () => {
		test("returns events for a specific instance in chronological order", () => {
			const log = new ActivityLog(db);
			log.log({ event: "a", instanceId: "inst-1" as InstanceId });
			log.log({ event: "b", instanceId: "inst-2" as InstanceId });
			log.log({ event: "c", instanceId: "inst-1" as InstanceId });

			const results = log.queryByInstance("inst-1" as InstanceId);
			expect(results).toHaveLength(2);
			expect(results[0]!.event).toBe("a");
			expect(results[1]!.event).toBe("c");
		});

		test("respects limit parameter", () => {
			const log = new ActivityLog(db);
			log.log({ event: "a", instanceId: "inst-1" as InstanceId });
			log.log({ event: "b", instanceId: "inst-1" as InstanceId });
			log.log({ event: "c", instanceId: "inst-1" as InstanceId });

			const results = log.queryByInstance("inst-1" as InstanceId, 2);
			expect(results).toHaveLength(2);
			expect(results[0]!.event).toBe("a");
			expect(results[1]!.event).toBe("b");
		});

		test("returns empty array for unknown instance", () => {
			const log = new ActivityLog(db);
			const results = log.queryByInstance("inst-unknown" as InstanceId);
			expect(results).toHaveLength(0);
		});
	});

	describe("queryByTenant()", () => {
		test("returns events for a specific tenant in chronological order", () => {
			const log = new ActivityLog(db);
			log.log({ event: "x", tenantId: "t-1" as TenantId });
			log.log({ event: "y", tenantId: "t-2" as TenantId });
			log.log({ event: "z", tenantId: "t-1" as TenantId });

			const results = log.queryByTenant("t-1" as TenantId);
			expect(results).toHaveLength(2);
			expect(results[0]!.event).toBe("x");
			expect(results[1]!.event).toBe("z");
		});

		test("respects limit parameter", () => {
			const log = new ActivityLog(db);
			log.log({ event: "a", tenantId: "t-1" as TenantId });
			log.log({ event: "b", tenantId: "t-1" as TenantId });
			log.log({ event: "c", tenantId: "t-1" as TenantId });

			const results = log.queryByTenant("t-1" as TenantId, 1);
			expect(results).toHaveLength(1);
			expect(results[0]!.event).toBe("a");
		});

		test("returns empty array for unknown tenant", () => {
			const log = new ActivityLog(db);
			const results = log.queryByTenant("t-unknown" as TenantId);
			expect(results).toHaveLength(0);
		});
	});
});
