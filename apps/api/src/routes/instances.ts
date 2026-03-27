import { Elysia, t } from "elysia";
import { eq } from "drizzle-orm";
import type { InstanceId } from "@boilerhouse/core";
import { InvalidTransitionError, InstanceStatusSchema } from "@boilerhouse/core";
import { instances, claims } from "@boilerhouse/db";
import { instanceHandleFrom } from "../transitions";
import type { RouteDeps } from "./deps";

export function instanceRoutes(deps: RouteDeps) {
	const { db, instanceManager, log } = deps;

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
				hasSidecar: !!(r.runtimeMeta as Record<string, unknown> | null)?.hasSidecar,
				lastActivity: r.lastActivity?.toISOString() ?? null,
				claimedAt: r.claimedAt?.toISOString() ?? null,
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

			if (row.poolStatus !== null) {
				set.status = 409;
				return { error: `Instance '${params.id}' is a pool instance and does not expose ports until claimed` };
			}

			const handle = instanceHandleFrom(instanceId, row.status);
			const endpoint = await deps.runtime.getEndpoint(handle);

			return {
				instanceId,
				status: row.status,
				endpoint,
			};
		})
		.get("/instances/:id/logs", async ({ params, query, set }) => {
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

			if (row.status === "destroyed" || row.status === "hibernated") {
				set.status = 409;
				return { error: `Instance '${params.id}' is ${row.status} — no logs available` };
			}

			if (!deps.runtime.logs) {
				set.status = 501;
				return { error: "Runtime does not support log retrieval" };
			}

			const tail = Math.min(Math.max(1, Number(query.tail) || 200), 5000);
			const handle = instanceHandleFrom(instanceId, row.status);
			const logs = await deps.runtime.logs(handle, tail);

			return { instanceId, logs };
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

			log?.info({ instanceId, command: body.command[0], exitCode: result.exitCode }, "Exec completed");
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

			log?.info({ instanceId }, "Instance destroyed via API");
			return { instanceId, status: "destroyed" };
		})
		.post("/instances/:id/hibernate", async ({ params, set }) => {
			const instanceId = params.id as InstanceId;

			const claim = db
				.select()
				.from(claims)
				.where(eq(claims.instanceId, instanceId))
				.get();

			if (!claim) {
				set.status = 404;
				return { error: `No active claim for instance '${params.id}'` };
			}

			const { tenantId, workloadId } = claim;

			try {
				await deps.tenantManager.release(tenantId, workloadId);
			} catch (err) {
				if (err instanceof InvalidTransitionError) {
					set.status = 409;
					return { error: err.message };
				}
				throw err;
			}

			// Return actual instance status (hibernated if overlay saved, destroyed otherwise)
			const row = db.select({ status: instances.status }).from(instances)
				.where(eq(instances.instanceId, instanceId)).get();

			log?.info({ instanceId, status: row?.status ?? "destroyed" }, "Instance hibernated via API");
			return { instanceId, status: row?.status ?? "destroyed" };
		});
}
