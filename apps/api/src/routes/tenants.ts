import { Elysia, t } from "elysia";
import { eq } from "drizzle-orm";
import type { TenantId } from "@boilerhouse/core";
import { InvalidTransitionError } from "@boilerhouse/core";
import { tenants, workloads, instances, snapshots } from "@boilerhouse/db";
import { NoGoldenSnapshotError } from "../tenant-manager";
import type { RouteDeps } from "./deps";

export function tenantRoutes(deps: RouteDeps) {
	const { db, tenantManager, eventBus } = deps;

	return new Elysia({ name: "tenants" })
		.post("/tenants/:id/claim", async ({ params, body, set }) => {
			const tenantId = params.id as TenantId;
			const { workload: workloadName } = body;

			if (deps.resourceLimiter && !deps.resourceLimiter.canCreate(deps.nodeId)) {
				set.status = 503;
				set.headers["Retry-After"] = "5";
				return { error: "Node at capacity" };
			}

			const workloadRow = db
				.select()
				.from(workloads)
				.where(eq(workloads.name, workloadName))
				.get();

			if (!workloadRow) {
				set.status = 404;
				return { error: `Workload '${workloadName}' not found` };
			}

			if (workloadRow.status !== "ready") {
				set.status = 503;
				set.headers["Retry-After"] = "5";
				return {
					error: `Workload '${workloadName}' is not ready (status: ${workloadRow.status})`,
				};
			}

			let result;
			try {
				result = await tenantManager.claim(
					tenantId,
					workloadRow.workloadId,
				);
			} catch (err) {
				if (err instanceof NoGoldenSnapshotError) {
					set.status = 503;
					return { error: err.message };
				}
				if (err instanceof InvalidTransitionError) {
					set.status = 409;
					return { error: err.message };
				}
				throw err;
			}

			eventBus.emit({
				type: "tenant.claimed",
				tenantId,
				instanceId: result.instanceId,
				workloadId: workloadRow.workloadId,
				source: result.source,
			});

			return {
				tenantId: result.tenantId,
				instanceId: result.instanceId,
				endpoint: result.endpoint,
				source: result.source,
				latencyMs: result.latencyMs,
			};
		}, {
			body: t.Object({
				workload: t.String({ minLength: 1 }),
			}),
		})
		.post("/tenants/:id/release", async ({ params, set }) => {
			const tenantId = params.id as TenantId;

			const tenantRow = db
				.select()
				.from(tenants)
				.where(eq(tenants.tenantId, tenantId))
				.get();

			if (!tenantRow) {
				set.status = 404;
				return { error: `Tenant '${params.id}' not found` };
			}

			const instanceId = tenantRow.instanceId;

			await tenantManager.release(tenantId);

			if (instanceId) {
				eventBus.emit({
					type: "tenant.released",
					tenantId,
					instanceId,
				});
			}

			return { released: true };
		})
		.get("/tenants/:id", ({ params, set }) => {
			const tenantId = params.id as TenantId;

			const tenantRow = db
				.select()
				.from(tenants)
				.where(eq(tenants.tenantId, tenantId))
				.get();

			if (!tenantRow) {
				set.status = 404;
				return { error: `Tenant '${params.id}' not found` };
			}

			// Get current instance if assigned
			let instance = null;
			if (tenantRow.instanceId) {
				const instanceRow = db
					.select()
					.from(instances)
					.where(eq(instances.instanceId, tenantRow.instanceId))
					.get();
				if (instanceRow) {
					instance = {
						instanceId: instanceRow.instanceId,
						status: instanceRow.status,
						createdAt: instanceRow.createdAt.toISOString(),
					};
				}
			}

			// Get snapshots for this tenant
			const tenantSnapshots = db
				.select()
				.from(snapshots)
				.where(eq(snapshots.tenantId, tenantId))
				.all()
				.map((s) => ({
					snapshotId: s.snapshotId,
					type: s.type,
					createdAt: s.createdAt.toISOString(),
				}));

			return {
				tenantId: tenantRow.tenantId,
				workloadId: tenantRow.workloadId,
				instanceId: tenantRow.instanceId,
				lastSnapshotId: tenantRow.lastSnapshotId,
				lastActivity: tenantRow.lastActivity?.toISOString() ?? null,
				createdAt: tenantRow.createdAt.toISOString(),
				instance,
				snapshots: tenantSnapshots,
			};
		})
		.get("/tenants", () => {
			const rows = db.select().from(tenants).all();
			return rows.map((r) => ({
				tenantId: r.tenantId,
				workloadId: r.workloadId,
				instanceId: r.instanceId,
				lastActivity: r.lastActivity?.toISOString() ?? null,
				createdAt: r.createdAt.toISOString(),
			}));
		});
}
