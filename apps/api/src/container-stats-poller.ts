import type { Runtime, InstanceId } from "@boilerhouse/core";
import type { DrizzleDb } from "@boilerhouse/db";
import { instances, workloads } from "@boilerhouse/db";
import { eq, notInArray } from "drizzle-orm";
import type { ContainerSnapshot, ContainerStatsProvider } from "@boilerhouse/o11y";

/**
 * Periodically polls Docker container stats and caches the results.
 * Used by the node metrics observable gauges.
 */
export class ContainerStatsPoller implements ContainerStatsProvider {
	private cache: ContainerSnapshot[] = [];
	private timer: ReturnType<typeof setInterval> | null = null;

	constructor(
		private readonly runtime: Runtime,
		private readonly db: DrizzleDb,
		private readonly intervalMs = 15_000,
	) {}

	start(): void {
		this.poll();
		this.timer = setInterval(() => this.poll(), this.intervalMs);
	}

	stop(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = null;
		}
	}

	getContainerStats(): ContainerSnapshot[] {
		return this.cache;
	}

	private async poll(): Promise<void> {
		if (!this.runtime.stats) {
			this.cache = [];
			return;
		}

		try {
			const rows = this.db
				.select({
					instanceId: instances.instanceId,
					workload: workloads.name,
					tenantId: instances.tenantId,
				})
				.from(instances)
				.innerJoin(workloads, eq(instances.workloadId, workloads.workloadId))
				.where(notInArray(instances.status, ["destroyed", "hibernated"]))
				.all();

			const results: ContainerSnapshot[] = [];
			for (const row of rows) {
				const stats = await this.runtime.stats({ instanceId: row.instanceId as InstanceId, running: true });
				if (stats) {
					results.push({
						instanceId: row.instanceId,
						workload: row.workload,
						tenant: row.tenantId ?? "",
						cpuFraction: stats.cpuFraction,
						memoryBytes: stats.memoryBytes,
					});
				}
			}
			this.cache = results;
		} catch {
			// Keep stale cache on error
		}
	}
}
