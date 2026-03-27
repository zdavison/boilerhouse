import { Elysia } from "elysia";
import { eq, count } from "drizzle-orm";
import type { NodeId } from "@boilerhouse/core";
import { nodes, instances } from "@boilerhouse/db";
import type { RouteDeps } from "./deps";

export function nodeRoutes(deps: RouteDeps) {
	const { db } = deps;

	return new Elysia({ name: "nodes" })
		.get("/nodes", () => {
			const rows = db.select().from(nodes).all();
			return rows.map((r) => ({
				nodeId: r.nodeId,
				runtimeType: r.runtimeType,
				capacity: r.capacity,
				status: r.status,
				statusDetail: r.statusDetail,
				lastHeartbeat: r.lastHeartbeat.toISOString(),
				createdAt: r.createdAt.toISOString(),
			}));
		})
		.get("/nodes/:id", ({ params, set }) => {
			const nodeId = params.id as NodeId;
			const row = db
				.select()
				.from(nodes)
				.where(eq(nodes.nodeId, nodeId))
				.get();

			if (!row) {
				set.status = 404;
				return { error: `Node '${params.id}' not found` };
			}

			const [instanceCount] = db
				.select({ count: count() })
				.from(instances)
				.where(eq(instances.nodeId, nodeId))
				.all();

			return {
				nodeId: row.nodeId,
				runtimeType: row.runtimeType,
				capacity: row.capacity,
				status: row.status,
				instanceCount: instanceCount!.count,
				lastHeartbeat: row.lastHeartbeat.toISOString(),
				createdAt: row.createdAt.toISOString(),
			};
		});
}
