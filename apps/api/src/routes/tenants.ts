import { Elysia, t } from "elysia";
import { eq, and } from "drizzle-orm";
import type { TenantId } from "@boilerhouse/core";
import { InvalidTransitionError } from "@boilerhouse/core";
import { tenants, workloads, instances, snapshots, claims } from "@boilerhouse/db";
import type { RouteDeps } from "./deps";

/**
 * Tenant IDs may be UUIDs (generated internally) or free-form strings
 * produced by trigger tenant-resolution (e.g. "slack-U12345", "tg-98765").
 * Allow printable ASCII sans control chars and path separators.
 */
const TENANT_ID_REGEX = "^[a-zA-Z0-9._@:-]{1,256}$";

export function tenantRoutes(deps: RouteDeps) {
	const { db, tenantManager, eventBus, log } = deps;

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
				if (err instanceof InvalidTransitionError) {
					set.status = 409;
					return { error: err.message };
				}
				log?.error(
					{ tenantId, workloadId: workloadRow.workloadId, err },
					"Unexpected error during claim",
				);
				throw err;
			}

			eventBus.emit({
				type: "tenant.claimed",
				tenantId,
				instanceId: result.instanceId,
				workloadId: workloadRow.workloadId,
				source: result.source,
			});

			const websocketPath = workloadRow.config.network?.websocket;

			return {
				tenantId: result.tenantId,
				instanceId: result.instanceId,
				endpoint: result.endpoint,
				source: result.source,
				latencyMs: result.latencyMs,
				...(websocketPath ? { websocket: websocketPath } : {}),
			};
		}, {
			params: t.Object({ id: t.String({ pattern: TENANT_ID_REGEX }) }),
			body: t.Object({
				workload: t.String({ minLength: 1 }),
			}),
		})
		.post("/tenants/:id/release", async ({ params, body, set }) => {
			const tenantId = params.id as TenantId;
			const { workload: workloadName } = body;

			const workloadRow = db
				.select()
				.from(workloads)
				.where(eq(workloads.name, workloadName))
				.get();

			if (!workloadRow) {
				set.status = 404;
				return { error: `Workload '${workloadName}' not found` };
			}

			const tenantRow = db
				.select()
				.from(tenants)
				.where(and(eq(tenants.tenantId, tenantId), eq(tenants.workloadId, workloadRow.workloadId)))
				.get();

			if (!tenantRow) {
				set.status = 404;
				return { error: `Tenant '${params.id}' not found for workload '${workloadName}'` };
			}

			// Get instanceId from claim
			const instanceId = db
				.select({ instanceId: claims.instanceId })
				.from(claims)
				.where(and(eq(claims.tenantId, tenantId), eq(claims.workloadId, workloadRow.workloadId)))
				.get()?.instanceId;

			await tenantManager.release(tenantId, workloadRow.workloadId);

			if (instanceId) {
				eventBus.emit({
					type: "tenant.released",
					tenantId,
					instanceId,
				});
			}

			return { released: true };
		}, {
			params: t.Object({ id: t.String({ pattern: TENANT_ID_REGEX }) }),
			body: t.Object({
				workload: t.String({ minLength: 1 }),
			}),
		})
		.get("/tenants/:id", ({ params, set }) => {
			const tenantId = params.id as TenantId;

			const tenantRows = db
				.select()
				.from(tenants)
				.where(eq(tenants.tenantId, tenantId))
				.all();

			if (tenantRows.length === 0) {
				set.status = 404;
				return { error: `Tenant '${params.id}' not found` };
			}

			// Build a per-workload map of workloadId → instanceId from claims
			const tenantClaims = db.select({ workloadId: claims.workloadId, instanceId: claims.instanceId }).from(claims).where(eq(claims.tenantId, tenantId)).all();
			const claimByWorkload = new Map(tenantClaims.map((c) => [c.workloadId, c.instanceId]));

			return tenantRows.map((tenantRow) => {
				const claimedInstanceId = claimByWorkload.get(tenantRow.workloadId) ?? null;

				// Get current instance if assigned
				let instance = null;
				if (claimedInstanceId) {
					const instanceRow = db
						.select()
						.from(instances)
						.where(eq(instances.instanceId, claimedInstanceId))
						.get();
					if (instanceRow) {
						instance = {
							instanceId: instanceRow.instanceId,
							status: instanceRow.status,
							createdAt: instanceRow.createdAt.toISOString(),
						};
					}
				}

				// Get snapshots for this tenant+workload
				const tenantSnapshots = db
					.select()
					.from(snapshots)
					.where(and(eq(snapshots.tenantId, tenantId), eq(snapshots.workloadId, tenantRow.workloadId)))
					.all()
					.map((s) => ({
						snapshotId: s.snapshotId,
						type: s.type,
						createdAt: s.createdAt.toISOString(),
					}));

				return {
					tenantId: tenantRow.tenantId,
					workloadId: tenantRow.workloadId,
					instanceId: claimedInstanceId,
					lastSnapshotId: tenantRow.lastSnapshotId,
					lastActivity: tenantRow.lastActivity?.toISOString() ?? null,
					createdAt: tenantRow.createdAt.toISOString(),
					instance,
					snapshots: tenantSnapshots,
				};
			});
		}, {
			params: t.Object({ id: t.String({ pattern: TENANT_ID_REGEX }) }),
		})
		.get("/tenants", () => {
			const rows = db.select().from(tenants).all();

			// Build a per-workload map of tenantId:workloadId → instanceId from claims
			const allClaims = db.select({ tenantId: claims.tenantId, workloadId: claims.workloadId, instanceId: claims.instanceId }).from(claims).all();
			const claimMap = new Map(allClaims.map((c) => [`${c.tenantId}:${c.workloadId}`, c.instanceId]));

			return rows.map((r) => ({
				tenantId: r.tenantId,
				workloadId: r.workloadId,
				instanceId: claimMap.get(`${r.tenantId}:${r.workloadId}`) ?? null,
				lastActivity: r.lastActivity?.toISOString() ?? null,
				createdAt: r.createdAt.toISOString(),
			}));
		});
}
