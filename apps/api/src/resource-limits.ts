import { eq, and, notInArray, count } from "drizzle-orm";
import type { NodeId, InstanceStatus } from "@boilerhouse/core";
import { instances } from "@boilerhouse/db";
import type { DrizzleDb } from "@boilerhouse/db";

export class CapacityExceededError extends Error {
	constructor(nodeId: NodeId) {
		super(`Node '${nodeId}' is at capacity`);
		this.name = "CapacityExceededError";
	}
}

/** Statuses that don't consume a runtime slot. */
const FREE_STATUSES: InstanceStatus[] = ["destroyed", "hibernated"];

export interface ResourceLimiterConfig {
	/**
	 * Maximum active instances per node (from env/config, not DB schema).
	 * @default 100
	 */
	maxInstances: number;
}

interface Waiter {
	resolve: () => void;
	reject: (err: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

/**
 * Enforces per-node instance capacity limits.
 *
 * Counts active instances by querying the DB (excludes destroyed/hibernated).
 * Provides a FIFO queue for callers that want to wait for capacity.
 */
export class ResourceLimiter {
	private readonly queues = new Map<string, Waiter[]>();

	constructor(
		private readonly db: DrizzleDb,
		private readonly config: ResourceLimiterConfig,
	) {}

	/** Returns true if the node has room for another active instance. */
	canCreate(nodeId: NodeId): boolean {
		return this.countActive(nodeId) < this.config.maxInstances;
	}

	/**
	 * Waits until capacity is available on the node.
	 * Rejects with {@link CapacityExceededError} if the timeout expires.
	 */
	waitForCapacity(nodeId: NodeId, timeoutMs: number): Promise<void> {
		if (this.canCreate(nodeId)) {
			return Promise.resolve();
		}

		return new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				// Remove this waiter from the queue
				const queue = this.queues.get(nodeId);
				if (queue) {
					const idx = queue.findIndex((w) => w.timer === timer);
					if (idx !== -1) queue.splice(idx, 1);
					if (queue.length === 0) this.queues.delete(nodeId);
				}
				reject(new CapacityExceededError(nodeId));
			}, timeoutMs);

			const waiter: Waiter = { resolve, reject, timer };
			let queue = this.queues.get(nodeId);
			if (!queue) {
				queue = [];
				this.queues.set(nodeId, queue);
			}
			queue.push(waiter);
		});
	}

	/** Wake the next FIFO waiter for this node, if capacity is available. */
	release(nodeId: NodeId): void {
		const queue = this.queues.get(nodeId);
		if (!queue || queue.length === 0) return;

		if (this.canCreate(nodeId)) {
			const waiter = queue.shift()!;
			clearTimeout(waiter.timer);
			waiter.resolve();
			if (queue.length === 0) this.queues.delete(nodeId);
		}
	}

	/** Returns the number of callers waiting for capacity on this node. */
	queueDepth(nodeId: NodeId): number {
		return this.queues.get(nodeId)?.length ?? 0;
	}

	/** Cleans up timers on shutdown. */
	dispose(): void {
		for (const [, queue] of this.queues) {
			for (const waiter of queue) {
				clearTimeout(waiter.timer);
			}
		}
		this.queues.clear();
	}

	private countActive(nodeId: NodeId): number {
		const [row] = this.db
			.select({ count: count() })
			.from(instances)
			.where(
				and(
					eq(instances.nodeId, nodeId),
					notInArray(instances.status, FREE_STATUSES),
				),
			)
			.all();
		return row?.count ?? 0;
	}
}
