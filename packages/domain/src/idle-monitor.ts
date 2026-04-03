import type { InstanceId, IdleAction } from "@boilerhouse/core";
import type { Logger } from "@boilerhouse/o11y";

export interface IdleConfig {
	/** Idle timeout in milliseconds (from workload.idle.timeout_seconds * 1000). */
	timeoutMs: number;
	/** Action to take when idle. */
	action: IdleAction;
}

export type IdleHandler = (
	instanceId: InstanceId,
	action: IdleAction,
) => Promise<void>;

interface WatchEntry {
	config: IdleConfig;
	lastMtime: Date;
	idleTimer: ReturnType<typeof setTimeout>;
	/** Only starts after the first reportActivity call (no agent = no heartbeat to miss). */
	heartbeatTimer: ReturnType<typeof setTimeout> | null;
}

export class IdleMonitor {
	private readonly watched = new Map<InstanceId, WatchEntry>();
	private readonly heartbeatDeadlineMs: number;
	private readonly log?: Logger;
	private handler: IdleHandler | null = null;

	constructor(opts: { defaultPollIntervalMs: number; log?: Logger }) {
		this.heartbeatDeadlineMs = opts.defaultPollIntervalMs * 2;
		this.log = opts.log;
	}

	/** Registers the handler called when an instance goes idle. Last-writer-wins. */
	onIdle(handler: IdleHandler): void {
		this.handler = handler;
	}

	/**
	 * Starts tracking an instance. If already watched, replaces the config
	 * and resets all timers.
	 */
	watch(instanceId: InstanceId, config: IdleConfig): void {
		// Clear existing entry if re-watching
		this.clearEntry(instanceId);

		const entry: WatchEntry = {
			config,
			lastMtime: new Date(0),
			idleTimer: setTimeout(() => this.fireIdle(instanceId), config.timeoutMs),
			heartbeatTimer: null,
		};

		this.watched.set(instanceId, entry);
	}

	/** Stops tracking an instance. No-op if not watched. */
	unwatch(instanceId: InstanceId): void {
		this.clearEntry(instanceId);
	}

	/**
	 * Reports filesystem activity from the guest agent.
	 * Always resets the heartbeat timer. Only resets the idle timer if
	 * `mtime` is newer than the last reported mtime.
	 */
	reportActivity(instanceId: InstanceId, mtime: Date): void {
		const entry = this.watched.get(instanceId);
		if (!entry) return;

		// Always (re)start heartbeat timer
		if (entry.heartbeatTimer) clearTimeout(entry.heartbeatTimer);
		entry.heartbeatTimer = setTimeout(
			() => this.fireIdle(instanceId),
			this.heartbeatDeadlineMs,
		);

		// Only reset idle timer if mtime is newer
		if (mtime > entry.lastMtime) {
			entry.lastMtime = mtime;
			clearTimeout(entry.idleTimer);
			entry.idleTimer = setTimeout(
				() => this.fireIdle(instanceId),
				entry.config.timeoutMs,
			);
		}
	}

	/** Clears all timers and watched entries. */
	stop(): void {
		for (const [instanceId] of this.watched) {
			this.clearEntry(instanceId);
		}
	}

	/** Fires the idle handler. Unwatches first to prevent double-fire. */
	private fireIdle(instanceId: InstanceId): void {
		const entry = this.watched.get(instanceId);
		if (!entry) return;

		const { action } = entry.config;

		// Unwatch before calling handler to prevent double-fire
		// (handler may call release() which calls unwatch())
		this.clearEntry(instanceId);

		if (this.handler) {
			this.handler(instanceId, action).catch((err) => {
				this.log?.error({ instanceId, err }, "Idle handler failed");
			});
		}
	}

	/** Clears timers and removes the entry from the map. */
	private clearEntry(instanceId: InstanceId): void {
		const entry = this.watched.get(instanceId);
		if (!entry) return;

		clearTimeout(entry.idleTimer);
		if (entry.heartbeatTimer) clearTimeout(entry.heartbeatTimer);
		this.watched.delete(instanceId);
	}
}
