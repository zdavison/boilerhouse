import { Elysia, t } from "elysia";
import { eq } from "drizzle-orm";
import type { InstanceId } from "@boilerhouse/core";
import { InvalidTransitionError, InstanceStatusSchema } from "@boilerhouse/core";
import { instances } from "@boilerhouse/db";
import { instanceHandleFrom } from "../instance-manager";
import type { RouteDeps } from "./deps";

export function instanceRoutes(deps: RouteDeps) {
	const { db, instanceManager } = deps;

	return new Elysia({ name: "instances" })
		.get("/instances", ({ query }) => {
			const { status } = query;
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
				statusDetail: r.statusDetail,
				createdAt: r.createdAt.toISOString(),
			}));
		}, {
			query: t.Object({
				status: t.Optional(InstanceStatusSchema),
			}),
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
		.get("/instances/:id/endpoint", async ({ params, set }) => {
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

			if (row.status === "destroyed" || row.status === "hibernated" || row.status === "hibernating") {
				set.status = 409;
				return { error: `Instance '${params.id}' is ${row.status}` };
			}

			const handle = instanceHandleFrom(instanceId, row.status);
			const endpoint = await deps.runtime.getEndpoint(handle);

			return {
				instanceId,
				status: row.status,
				endpoint,
			};
		})
	
			.post("/instances/:id/exec", async ({ params, body, set }) => {
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

			if (row.status !== "active" && row.status !== "restoring") {
				set.status = 409;
				return { error: `Instance '${params.id}' is ${row.status}, must be active` };
			}

			const handle = instanceHandleFrom(instanceId, row.status);
			const result = await deps.runtime.exec(handle, body.command);

			return {
				exitCode: result.exitCode,
				stdout: result.stdout,
				stderr: result.stderr,
			};
		}, {
			body: t.Object({
				command: t.Array(t.String(), { minItems: 1 }),
			}),
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

			try {
				await instanceManager.destroy(instanceId);
			} catch (err) {
				if (err instanceof InvalidTransitionError) {
					set.status = 409;
					return { error: err.message };
				}
				throw err;
			}

			return { instanceId, status: "destroyed" };
		});
}
