import { eq } from "drizzle-orm";
import type { WorkloadId } from "@boilerhouse/core";
import type { DrizzleDb } from "@boilerhouse/db";
import { buildLogs } from "@boilerhouse/db";

export interface BootstrapLogEntry {
	timestamp: string;
	text: string;
}

const DEFAULT_MAX_LINES = 5000;

export class BootstrapLogStore {
	private readonly maxLines: number;

	constructor(
		private readonly db: DrizzleDb,
		maxLines = DEFAULT_MAX_LINES,
	) {
		this.maxLines = maxLines;
	}

	/** Append a log line for a workload. Returns the created entry. */
	append(workloadId: WorkloadId, text: string): BootstrapLogEntry {
		const now = new Date();

		this.db
			.insert(buildLogs)
			.values({ workloadId, text, createdAt: now })
			.run();

		// Evict oldest lines when over the cap
		const count = this.db
			.select({ id: buildLogs.id })
			.from(buildLogs)
			.where(eq(buildLogs.workloadId, workloadId))
			.all().length;

		if (count > this.maxLines) {
			const excess = count - this.maxLines;
			const toDelete = this.db
				.select({ id: buildLogs.id })
				.from(buildLogs)
				.where(eq(buildLogs.workloadId, workloadId))
				.orderBy(buildLogs.id)
				.limit(excess)
				.all();

			for (const row of toDelete) {
				this.db.delete(buildLogs).where(eq(buildLogs.id, row.id)).run();
			}
		}

		return { timestamp: now.toISOString(), text };
	}

	/** Get all log lines for a workload, or empty array if none. */
	getLines(workloadId: WorkloadId): BootstrapLogEntry[] {
		const rows = this.db
			.select()
			.from(buildLogs)
			.where(eq(buildLogs.workloadId, workloadId))
			.orderBy(buildLogs.id)
			.all();

		return rows.map((r) => ({
			timestamp: r.createdAt.toISOString(),
			text: r.text,
		}));
	}

	/** Clear all log lines for a workload (e.g. on retry). */
	clear(workloadId: WorkloadId): void {
		this.db
			.delete(buildLogs)
			.where(eq(buildLogs.workloadId, workloadId))
			.run();
	}
}
