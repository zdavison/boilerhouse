import { Elysia } from "elysia";
import { eq, count, and, not } from "drizzle-orm";
import { validateWorkload, generateWorkloadId } from "@boilerhouse/core";
import { workloads, instances, snapshots } from "@boilerhouse/db";
import type { RouteDeps } from "./deps";

export function workloadRoutes(deps: RouteDeps) {
	const { db, bootstrapLogStore, poolManager } = deps;

	return new Elysia({ name: "workloads" })
		.post("/workloads", async ({ request, set }) => {
			let body: unknown;
			try {
				body = await request.json();
			} catch {
				set.status = 400;
				return { error: "Invalid JSON" };
			}

			let workload;
			try {
				workload = validateWorkload(body);
			} catch (err) {
				set.status = 400;
				const message =
					err instanceof Error ? err.message : "Invalid workload";
				return { error: message };
			}

			const existing = db
				.select()
				.from(workloads)
				.where(
					and(
						eq(workloads.name, workload.workload.name),
						eq(workloads.version, workload.workload.version),
					),
				)
				.get();

			if (existing) {
				set.status = 409;
				return {
					error: `Workload ${workload.workload.name}@${workload.workload.version} already exists`,
				};
			}

			const workloadId = generateWorkloadId();
			const now = new Date();

			db.insert(workloads)
				.values({
					workloadId,
					name: workload.workload.name,
					version: workload.workload.version,
					config: workload,
					status: "creating",
					createdAt: now,
					updatedAt: now,
				})
				.run();

			// Enqueue workload preparation in the background
			if (poolManager) {
				const pm = poolManager;
				pm.prime(workloadId).catch((err: unknown) => {
					const message = err instanceof Error ? err.message : String(err);
					db.update(workloads).set({ status: "error", statusDetail: message, updatedAt: new Date() }).where(eq(workloads.workloadId, workloadId)).run();
				});
			} else {
				// No pool manager — transition workload directly to ready
				db.update(workloads)
					.set({ status: "ready", updatedAt: new Date() })
					.where(eq(workloads.workloadId, workloadId))
					.run();
			}

			set.status = 201;
			return {
				workloadId,
				name: workload.workload.name,
				version: workload.workload.version,
				status: "creating" as const,
			};
		})
		.get("/workloads", () => {
			const rows = db.select().from(workloads).all();
			return rows.map((r) => ({
				workloadId: r.workloadId,
				name: r.name,
				version: r.version,
				status: r.status,
				statusDetail: r.statusDetail,
				createdAt: r.createdAt.toISOString(),
				updatedAt: r.updatedAt.toISOString(),
			}));
		})
		.get("/workloads/:name", ({ params, set }) => {
			const row = db
				.select()
				.from(workloads)
				.where(eq(workloads.name, params.name))
				.get();

			if (!row) {
				set.status = 404;
				return { error: `Workload '${params.name}' not found` };
			}

			const [instanceCount] = db
				.select({ count: count() })
				.from(instances)
				.where(eq(instances.workloadId, row.workloadId))
				.all();

			return {
				workloadId: row.workloadId,
				name: row.name,
				version: row.version,
				status: row.status,
				statusDetail: row.statusDetail,
				config: row.config,
				instanceCount: instanceCount!.count,
				createdAt: row.createdAt.toISOString(),
				updatedAt: row.updatedAt.toISOString(),
			};
		})
		.get("/workloads/:name/snapshots", ({ params, set }) => {
			const row = db
				.select()
				.from(workloads)
				.where(eq(workloads.name, params.name))
				.get();

			if (!row) {
				set.status = 404;
				return { error: `Workload '${params.name}' not found` };
			}

			const rows = db
				.select()
				.from(snapshots)
				.where(eq(snapshots.workloadId, row.workloadId))
				.all();

			return rows.map((s) => ({
				snapshotId: s.snapshotId,
				type: s.type,
				status: s.status,
				instanceId: s.instanceId,
				tenantId: s.tenantId,
				workloadId: s.workloadId,
				nodeId: s.nodeId,
				sizeBytes: s.sizeBytes,
				createdAt: s.createdAt.toISOString(),
			}));
		})
		.get("/workloads/:name/logs", ({ params, set }) => {
			const row = db
				.select()
				.from(workloads)
				.where(eq(workloads.name, params.name))
				.get();

			if (!row) {
				set.status = 404;
				return { error: `Workload '${params.name}' not found` };
			}

			return bootstrapLogStore.getLines(row.workloadId);
		})
		.delete("/workloads/:name", ({ params, set }) => {
			const row = db
				.select()
				.from(workloads)
				.where(eq(workloads.name, params.name))
				.get();

			if (!row) {
				set.status = 404;
				return { error: `Workload '${params.name}' not found` };
			}

			if (row.status === "creating") {
				set.status = 409;
				return {
					error: `Cannot delete workload '${params.name}': workload is still being initialised`,
				};
			}

			// Check for active (non-destroyed) instances
			const activeInstances = db
				.select({ count: count() })
				.from(instances)
				.where(
					and(
						eq(instances.workloadId, row.workloadId),
						not(eq(instances.status, "destroyed")),
					),
				)
				.all();

			if (activeInstances[0]!.count > 0) {
				set.status = 409;
				return {
					error: `Cannot delete workload '${params.name}': has ${activeInstances[0]!.count} active instance(s)`,
				};
			}

			// Remove snapshots for this workload
			db.delete(snapshots)
				.where(eq(snapshots.workloadId, row.workloadId))
				.run();

			// Remove destroyed instance rows to satisfy FK constraint
			db.delete(instances)
				.where(
					and(
						eq(instances.workloadId, row.workloadId),
						eq(instances.status, "destroyed"),
					),
				)
				.run();

			db.delete(workloads)
				.where(eq(workloads.workloadId, row.workloadId))
				.run();

			return { deleted: true };
		});
}
