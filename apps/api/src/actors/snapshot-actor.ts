import { eq } from "drizzle-orm";
import type { SnapshotId, SnapshotStatus, SnapshotEvent } from "@boilerhouse/core";
import { snapshotTransition } from "@boilerhouse/core";
import type { DrizzleDb } from "@boilerhouse/db";
import { snapshots } from "@boilerhouse/db";

export class SnapshotActor {
	constructor(
		private readonly db: DrizzleDb,
		private readonly snapshotId: SnapshotId,
	) {}

	get status(): SnapshotStatus {
		const row = this.db
			.select({ status: snapshots.status })
			.from(snapshots)
			.where(eq(snapshots.snapshotId, this.snapshotId))
			.get();
		if (!row) throw new Error(`Snapshot not found: ${this.snapshotId}`);
		return row.status as SnapshotStatus;
	}

	/** Validates the event, persists the new status, and returns it. */
	send(event: SnapshotEvent): SnapshotStatus {
		const current = this.status;
		const next = snapshotTransition(current, event);
		this.db
			.update(snapshots)
			.set({ status: next })
			.where(eq(snapshots.snapshotId, this.snapshotId))
			.run();
		return next;
	}

	/** Validates the event without persisting. Use for fail-fast guards. */
	validate(event: SnapshotEvent): SnapshotStatus {
		return snapshotTransition(this.status, event);
	}

	/** Bypasses the state machine and writes status directly (recovery only). */
	forceStatus(status: SnapshotStatus): void {
		this.db
			.update(snapshots)
			.set({ status })
			.where(eq(snapshots.snapshotId, this.snapshotId))
			.run();
	}
}
