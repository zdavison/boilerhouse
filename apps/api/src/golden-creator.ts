import type { WorkloadId, Workload } from "@boilerhouse/core";
import type { DrizzleDb } from "@boilerhouse/db";
import type { SnapshotManager } from "./snapshot-manager";
import type { EventBus } from "./event-bus";
import { WorkloadActor } from "./actors";

interface QueueItem {
	workloadId: WorkloadId;
	workload: Workload;
}

export class GoldenCreator {
	private readonly queue: QueueItem[] = [];
	private processing = false;

	constructor(
		private readonly db: DrizzleDb,
		private readonly snapshotManager: SnapshotManager,
		private readonly eventBus: EventBus,
	) {}

	/** Enqueue a workload for background golden snapshot creation. */
	enqueue(workloadId: WorkloadId, workload: Workload): void {
		this.queue.push({ workloadId, workload });
		if (!this.processing) {
			this.processQueue();
		}
	}

	/** Number of items waiting in the queue (not including the current one). */
	get pending(): number {
		return this.queue.length;
	}

	/** Whether the creator is currently processing an item. */
	get isProcessing(): boolean {
		return this.processing;
	}

	private processQueue(): void {
		// Fire-and-forget — errors are handled internally per item
		this.processQueueAsync().catch((err) => {
			console.error("GoldenCreator: unexpected queue error:", err);
		});
	}

	private async processQueueAsync(): Promise<void> {
		if (this.processing) return;
		this.processing = true;

		try {
			while (this.queue.length > 0) {
				const item = this.queue.shift()!;
				await this.processItem(item);
			}
		} finally {
			this.processing = false;
		}
	}

	private async processItem(item: QueueItem): Promise<void> {
		const actor = new WorkloadActor(this.db, item.workloadId);

		try {
			await this.snapshotManager.createGolden(item.workloadId, item.workload);
			actor.send("created");

			this.eventBus.emit({
				type: "workload.state",
				workloadId: item.workloadId,
				status: "ready",
			});

			console.log(`GoldenCreator: golden snapshot ready for workload ${item.workloadId}`);
		} catch (err) {
			console.error(
				`GoldenCreator: failed to create golden snapshot for workload ${item.workloadId}: ${err instanceof Error ? err.message : err}`,
			);

			try {
				actor.send("failed");
			} catch {
				// Workload may have been deleted while processing
			}

			this.eventBus.emit({
				type: "workload.state",
				workloadId: item.workloadId,
				status: "error",
			});
		}
	}
}
