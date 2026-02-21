import { Elysia } from "elysia";
import { snapshots, workloads } from "@boilerhouse/db";
import type { RouteDeps } from "./deps";

export function snapshotRoutes(deps: RouteDeps) {
	const { db } = deps;

	return new Elysia({ name: "snapshots" }).get("/snapshots", () => {
		const rows = db.select().from(snapshots).all();

		// Build workloadId → name lookup
		const workloadRows = db.select().from(workloads).all();
		const nameById = new Map(workloadRows.map((w) => [w.workloadId, w.name]));

		return rows.map((s) => ({
			snapshotId: s.snapshotId,
			type: s.type,
			instanceId: s.instanceId,
			tenantId: s.tenantId,
			workloadId: s.workloadId,
			workloadName: nameById.get(s.workloadId) ?? null,
			nodeId: s.nodeId,
			sizeBytes: s.sizeBytes,
			createdAt: s.createdAt.toISOString(),
		}));
	});
}
