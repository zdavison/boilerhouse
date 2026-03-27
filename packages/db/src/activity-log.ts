import { eq, asc, desc, count } from "drizzle-orm";
import type { InstanceId, TenantId } from "@boilerhouse/core";
import { activityLog, type ActivityLogInsert, type ActivityLogRow } from "./schema";
import type { DrizzleDb } from "./database";

/** Entry to insert into the activity log (without id/createdAt). */
export type ActivityLogEntry = Omit<ActivityLogInsert, "id" | "createdAt">;

/**
 * Structured activity log backed by the `activity_log` table.
 *
 * Provides insert-with-pruning and query helpers for instance/tenant scoping.
 */
export class ActivityLog {
	/**
	 * @param db - Drizzle database instance.
	 * @param maxEvents - Maximum number of events to retain. When exceeded,
	 *   the oldest events are pruned after each insert.
	 *   @default Infinity
	 */
	constructor(
		private readonly db: DrizzleDb,
		private readonly maxEvents: number = Number.POSITIVE_INFINITY,
	) {}

	/** Inserts a log entry and prunes excess rows if over `maxEvents`. */
	log(entry: ActivityLogEntry): void {
		this.db
			.insert(activityLog)
			.values({ ...entry, createdAt: new Date() })
			.run();

		if (this.maxEvents < Number.POSITIVE_INFINITY) {
			this.prune();
		}
	}

	/**
	 * Returns events for a given instance in chronological order (oldest first).
	 *
	 * @param instanceId - The instance to query.
	 * @param limit - Maximum number of events to return.
	 *   @default 100
	 */
	queryByInstance(instanceId: InstanceId, limit = 100): ActivityLogRow[] {
		return this.db
			.select()
			.from(activityLog)
			.where(eq(activityLog.instanceId, instanceId))
			.orderBy(asc(activityLog.id))
			.limit(limit)
			.all();
	}

	/**
	 * Returns the most recent events across all instances/tenants (newest first).
	 *
	 * @param limit - Maximum number of events to return.
	 *   @default 200
	 */
	queryRecent(limit = 200): ActivityLogRow[] {
		return this.db
			.select()
			.from(activityLog)
			.orderBy(desc(activityLog.id))
			.limit(limit)
			.all();
	}

	/**
	 * Returns events for a given tenant in chronological order (oldest first).
	 *
	 * @param tenantId - The tenant to query.
	 * @param limit - Maximum number of events to return.
	 *   @default 100
	 */
	queryByTenant(tenantId: TenantId, limit = 100): ActivityLogRow[] {
		return this.db
			.select()
			.from(activityLog)
			.where(eq(activityLog.tenantId, tenantId))
			.orderBy(asc(activityLog.id))
			.limit(limit)
			.all();
	}

	/** Removes the oldest rows to keep total count at or below `maxEvents`. */
	private prune(): void {
		const [result] = this.db
			.select({ total: count() })
			.from(activityLog)
			.all();

		const total = result?.total ?? 0;
		if (total <= this.maxEvents) return;

		const excess = total - this.maxEvents;

		// Delete the oldest `excess` rows by id
		const oldestRows = this.db
			.select({ id: activityLog.id })
			.from(activityLog)
			.orderBy(asc(activityLog.id))
			.limit(excess)
			.all();

		for (const row of oldestRows) {
			this.db.delete(activityLog).where(eq(activityLog.id, row.id)).run();
		}
	}
}
