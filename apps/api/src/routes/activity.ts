import { Elysia } from "elysia";
import { eq, and, desc } from "drizzle-orm";
import type { InstanceId, TenantId, WorkloadId } from "@boilerhouse/core";
import { activityLog as activityLogTable } from "@boilerhouse/db";
import type { RouteDeps } from "./deps";

export function activityRoutes(deps: RouteDeps) {
	const { db, activityLog } = deps;

	return new Elysia({ name: "activity" }).get("/audit", ({ query }) => {
		const rawLimit = Number(query.limit) || 200;
		const limit = Math.min(Math.max(1, rawLimit), 500);

		const { instanceId, tenantId, workloadId, event } = query;

		// If any filter is specified, use filtered query
		if (instanceId || tenantId || workloadId || event) {
			const conditions = [];
			if (instanceId) conditions.push(eq(activityLogTable.instanceId, instanceId as InstanceId));
			if (tenantId) conditions.push(eq(activityLogTable.tenantId, tenantId as TenantId));
			if (workloadId) conditions.push(eq(activityLogTable.workloadId, workloadId as WorkloadId));
			if (event) conditions.push(eq(activityLogTable.event, event));

			const rows = db
				.select()
				.from(activityLogTable)
				.where(conditions.length === 1 ? conditions[0]! : and(...conditions))
				.orderBy(desc(activityLogTable.id))
				.limit(limit)
				.all();

			return rows.map(formatRow);
		}

		// No filters — use the existing optimised query
		return activityLog.queryRecent(limit).map(formatRow);
	});
}

function formatRow(row: { id: number; event: string; instanceId: string | null; workloadId: string | null; nodeId: string | null; tenantId: string | null; metadata: unknown; createdAt: Date }) {
	return {
		id: row.id,
		event: row.event,
		instanceId: row.instanceId,
		workloadId: row.workloadId,
		nodeId: row.nodeId,
		tenantId: row.tenantId,
		metadata: row.metadata,
		createdAt: row.createdAt.toISOString(),
	};
}
