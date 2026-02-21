import { eq } from "drizzle-orm";
import type { WorkloadId, WorkloadStatus, WorkloadEvent } from "@boilerhouse/core";
import { workloadTransition } from "@boilerhouse/core";
import type { DrizzleDb } from "@boilerhouse/db";
import { workloads } from "@boilerhouse/db";

export class WorkloadActor {
	constructor(
		private readonly db: DrizzleDb,
		private readonly workloadId: WorkloadId,
	) {}

	get status(): WorkloadStatus {
		const row = this.db
			.select({ status: workloads.status })
			.from(workloads)
			.where(eq(workloads.workloadId, this.workloadId))
			.get();
		if (!row) throw new Error(`Workload not found: ${this.workloadId}`);
		return row.status;
	}

	/** Validates the event, persists the new status, and returns it. */
	send(event: WorkloadEvent): WorkloadStatus {
		const current = this.status;
		const next = workloadTransition(current, event);
		this.db
			.update(workloads)
			.set({ status: next })
			.where(eq(workloads.workloadId, this.workloadId))
			.run();
		return next;
	}

	/** Validates the event without persisting. Use for fail-fast guards. */
	validate(event: WorkloadEvent): WorkloadStatus {
		return workloadTransition(this.status, event);
	}

	/** Bypasses the state machine and writes status directly (recovery only). */
	forceStatus(status: WorkloadStatus): void {
		this.db
			.update(workloads)
			.set({ status })
			.where(eq(workloads.workloadId, this.workloadId))
			.run();
	}
}
