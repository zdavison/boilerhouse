import { Elysia } from "elysia";
import { eq, count, and, not } from "drizzle-orm";
import { parseWorkload, generateWorkloadId } from "@boilerhouse/core";
import { workloads, instances } from "@boilerhouse/db";
import type { RouteDeps } from "./deps";

export function workloadRoutes(deps: RouteDeps) {
	const { db } = deps;

	return new Elysia({ name: "workloads" })
		.post("/workloads", async ({ request, set }) => {
			const toml = await request.text();

			let workload;
			try {
				workload = parseWorkload(toml);
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
					createdAt: now,
					updatedAt: now,
				})
				.run();

			set.status = 201;
			return {
				workloadId,
				name: workload.workload.name,
				version: workload.workload.version,
			};
		})
		.get("/workloads", () => {
			const rows = db.select().from(workloads).all();
			return rows.map((r) => ({
				workloadId: r.workloadId,
				name: r.name,
				version: r.version,
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
				config: row.config,
				instanceCount: instanceCount!.count,
				createdAt: row.createdAt.toISOString(),
				updatedAt: row.updatedAt.toISOString(),
			};
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
