import type { WorkloadId } from "@boilerhouse/core";
import type { DrizzleDb } from "@boilerhouse/db";
import { loadWorkloadsFromDir, workloads } from "@boilerhouse/db";
import { eq } from "drizzle-orm";
import { workloadTransition } from "@boilerhouse/core";
import { createLogger } from "@boilerhouse/o11y";

const log = createLogger("WorkloadWatcher");

export interface WorkloadWatcherOptions {
	onNew: (workloadId: WorkloadId) => Promise<void>;
	onUpdated: (workloadId: WorkloadId) => Promise<void>;
	pollIntervalMs: number;
}

export class WorkloadWatcher {
	private timer: ReturnType<typeof setInterval> | null = null;
	private scanning = false;

	constructor(
		private readonly db: DrizzleDb,
		private readonly dir: string,
		private readonly options: WorkloadWatcherOptions,
	) {}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => {
			this.scan().catch((err) => {
				log.error({ err }, "Workload scan failed");
			});
		}, this.options.pollIntervalMs);
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	async scan(): Promise<void> {
		if (this.scanning) return;
		this.scanning = true;
		try {
			const result = await loadWorkloadsFromDir(this.db, this.dir);

			for (const workloadId of result.newWorkloadIds) {
				await this.options.onNew(workloadId as WorkloadId);
			}

			for (const workloadId of result.updatedWorkloadIds) {
				// Transition to "creating" so the prime/healthcheck flow can run
				const row = this.db.select().from(workloads)
					.where(eq(workloads.workloadId, workloadId as WorkloadId))
					.get();
				if (row) {
					const event = row.status === "error" ? "retry" : "recover";
					const next = workloadTransition(row.status as "ready" | "error", event as "recover" | "retry");
					this.db.update(workloads)
						.set({ status: next })
						.where(eq(workloads.workloadId, workloadId as WorkloadId))
						.run();
				}
				await this.options.onUpdated(workloadId as WorkloadId);
			}
		} finally {
			this.scanning = false;
		}
	}
}
