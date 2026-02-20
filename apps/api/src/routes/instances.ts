import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import type { InstanceId, InstanceStatus } from "@boilerhouse/core";
import { instances } from "@boilerhouse/db";
import type { RouteDeps } from "./deps";

export function instanceRoutes(deps: RouteDeps) {
	const { db, instanceManager, eventBus } = deps;

	return new Elysia({ name: "instances" })
		.get("/instances", ({ query }) => {
			const status = query.status as InstanceStatus | undefined;
			let rows;

			if (status) {
				rows = db
					.select()
					.from(instances)
					.where(eq(instances.status, status))
					.all();
			} else {
				rows = db.select().from(instances).all();
			}

			return rows.map((r) => ({
				instanceId: r.instanceId,
				workloadId: r.workloadId,
				nodeId: r.nodeId,
				tenantId: r.tenantId,
				status: r.status,
				createdAt: r.createdAt.toISOString(),
			}));
		})
		.get("/instances/:id", ({ params, set }) => {
			const row = db
				.select()
				.from(instances)
				.where(eq(instances.instanceId, params.id as InstanceId))
				.get();

			if (!row) {
				set.status = 404;
				return { error: `Instance '${params.id}' not found` };
			}

			return {
				instanceId: row.instanceId,
				workloadId: row.workloadId,
				nodeId: row.nodeId,
				tenantId: row.tenantId,
				status: row.status,
				runtimeMeta: row.runtimeMeta,
				lastActivity: row.lastActivity?.toISOString() ?? null,
				claimedAt: row.claimedAt?.toISOString() ?? null,
				createdAt: row.createdAt.toISOString(),
			};
		})
		.post("/instances/:id/stop", async ({ params, set }) => {
			const instanceId = params.id as InstanceId;
			const row = db
				.select()
				.from(instances)
				.where(eq(instances.instanceId, instanceId))
				.get();

			if (!row) {
				set.status = 404;
				return { error: `Instance '${params.id}' not found` };
			}

			await instanceManager.stop(instanceId);

			eventBus.emit({
				type: "instance.state",
				instanceId,
				status: "destroyed",
				workloadId: row.workloadId,
				tenantId: row.tenantId ?? undefined,
			});

			return { instanceId, status: "destroyed" };
		})
		.post("/instances/:id/hibernate", async ({ params, set }) => {
			const instanceId = params.id as InstanceId;
			const row = db
				.select()
				.from(instances)
				.where(eq(instances.instanceId, instanceId))
				.get();

			if (!row) {
				set.status = 404;
				return { error: `Instance '${params.id}' not found` };
			}

			const ref = await instanceManager.hibernate(instanceId);

			eventBus.emit({
				type: "instance.state",
				instanceId,
				status: "hibernated",
				workloadId: row.workloadId,
				tenantId: row.tenantId ?? undefined,
			});

			return {
				instanceId,
				status: "hibernated",
				snapshotId: ref.id,
			};
		})
		.post("/instances/:id/destroy", async ({ params, set }) => {
			const instanceId = params.id as InstanceId;
			const row = db
				.select()
				.from(instances)
				.where(eq(instances.instanceId, instanceId))
				.get();

			if (!row) {
				set.status = 404;
				return { error: `Instance '${params.id}' not found` };
			}

			await instanceManager.destroy(instanceId);

			eventBus.emit({
				type: "instance.state",
				instanceId,
				status: "destroyed",
				workloadId: row.workloadId,
				tenantId: row.tenantId ?? undefined,
			});

			return { instanceId, status: "destroyed" };
		});
}
