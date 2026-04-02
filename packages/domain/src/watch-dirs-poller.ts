import type { InstanceId } from "@boilerhouse/core";
import type { InstanceManager } from "./instance-manager";
import type { IdleMonitor } from "./idle-monitor";

/**
 * Polls watched directories inside running instances and forwards mtime
 * updates to the IdleMonitor, enabling filesystem-activity-based idle detection.
 *
 * When watch_dirs are configured on a workload, the idle timeout counts down
 * from the last observed file change rather than from instance creation.
 *
 * Two guards prevent runtime saturation:
 * - Per-instance: if a poll is still in-flight the next tick is skipped.
 * - Global: at most `maxConcurrentExecs` statWatchDirs calls run at once;
 *   excess ticks queue and drain as slots free up.
 */
export class WatchDirsPoller {
	private readonly intervals = new Map<InstanceId, ReturnType<typeof setInterval>>();
	/** Instances whose current poll has not yet resolved. */
	private readonly busy = new Set<InstanceId>();
	private activeExecs = 0;
	private readonly waitQueue: Array<() => void> = [];

	constructor(
		private readonly instanceManager: InstanceManager,
		private readonly idleMonitor: IdleMonitor,
		/** How often to exec stat inside each watched instance. */
		readonly pollIntervalMs: number = 5_000,
		/** Maximum number of concurrent statWatchDirs execs across all instances. */
		readonly maxConcurrentExecs: number = 10,
	) {}

	private acquireSemaphore(): Promise<void> {
		if (this.activeExecs < this.maxConcurrentExecs) {
			this.activeExecs++;
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			this.waitQueue.push(() => {
				this.activeExecs++;
				resolve();
			});
		});
	}

	private releaseSemaphore(): void {
		const next = this.waitQueue.shift();
		if (next) {
			next();
		} else {
			this.activeExecs--;
		}
	}

	/**
	 * Starts polling `dirs` inside `instanceId` at `pollIntervalMs`.
	 * Replaces any existing polling for this instance.
	 */
	startPolling(instanceId: InstanceId, dirs: string[]): void {
		this.stopPolling(instanceId);

		const interval = setInterval(async () => {
			// Skip if the previous poll for this instance hasn't finished yet.
			if (this.busy.has(instanceId)) return;
			this.busy.add(instanceId);
			await this.acquireSemaphore();
			try {
				const mtime = await this.instanceManager.statWatchDirs(instanceId, dirs);
				// null means exec failed — skip reportActivity so the heartbeat expires
				if (mtime !== null) {
					this.idleMonitor.reportActivity(instanceId, mtime);
				}
			} catch {
				// Unexpected error — heartbeat will expire naturally
			} finally {
				this.releaseSemaphore();
				this.busy.delete(instanceId);
			}
		}, this.pollIntervalMs);

		this.intervals.set(instanceId, interval);
	}

	/** Stops polling for an instance. No-op if not polling. */
	stopPolling(instanceId: InstanceId): void {
		const interval = this.intervals.get(instanceId);
		if (interval) {
			clearInterval(interval);
			this.intervals.delete(instanceId);
		}
	}

	/** Stops all active polling intervals. */
	stopAll(): void {
		for (const [instanceId] of this.intervals) {
			this.stopPolling(instanceId);
		}
	}
}
