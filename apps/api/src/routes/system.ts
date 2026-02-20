import { Elysia } from "elysia";
import { count } from "drizzle-orm";
import { instances, snapshots, nodes } from "@boilerhouse/db";
import type { RouteDeps } from "./deps";

export function systemRoutes(deps: RouteDeps) {
	const { db } = deps;

	return new Elysia({ name: "system" })
		.get("/health", () => ({ status: "ok" }))
		.get("/stats", () => {
			const instanceRows = db.select().from(instances).all();
			const statusCounts: Record<string, number> = {};
			for (const row of instanceRows) {
				statusCounts[row.status] = (statusCounts[row.status] ?? 0) + 1;
			}

			const [snapshotCount] = db
				.select({ count: count() })
				.from(snapshots)
				.all();

			const [nodeCount] = db
				.select({ count: count() })
				.from(nodes)
				.all();

			return {
				instances: statusCounts,
				snapshots: snapshotCount!.count,
				nodes: nodeCount!.count,
			};
		});
}
