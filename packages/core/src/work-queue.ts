/**
 * A concurrency-limited async work queue with optional key-based deduplication.
 *
 * Items are processed FIFO. When a `key` function is provided, enqueueing an
 * item whose key already exists in the queue is a no-op (dedup).
 *
 * Processing starts automatically on the first `enqueue` call and stops when
 * the queue drains. New items enqueued while processing are picked up without
 * restarting the loop.
 *
 * Designed to be swappable with a Redis-backed implementation later — the
 * public API is intentionally minimal.
 */

export interface WorkQueueOptions<T> {
	/** Called for each item. Throwing rejects that item only. */
	process: (item: T) => Promise<void>;
	/** Maximum number of items processed concurrently. @default 1 */
	concurrency?: number;
	/**
	 * Extract a dedup key from an item. When set, an item whose key is
	 * already in the queue will be silently dropped on `enqueue`.
	 */
	key?: (item: T) => string;
	/** Called when `process` throws. If omitted the error is swallowed. */
	onError?: (err: unknown, item: T) => void;
}

export class WorkQueue<T> {
	private readonly items: T[] = [];
	/** Set of keys currently in `items`, for O(1) dedup lookups. */
	private readonly keys = new Set<string>();

	private readonly processItem: (item: T) => Promise<void>;
	private readonly maxConcurrency: number;
	private readonly keyFn?: (item: T) => string;
	private readonly onError?: (err: unknown, item: T) => void;

	private draining = false;
	private inflight = 0;
	private slotWaiters: Array<() => void> = [];

	constructor(opts: WorkQueueOptions<T>) {
		this.processItem = opts.process;
		this.maxConcurrency = opts.concurrency ?? 1;
		this.keyFn = opts.key;
		this.onError = opts.onError;
	}

	/** Add an item to the queue. Starts processing if idle. */
	enqueue(item: T): void {
		if (this.keyFn) {
			const k = this.keyFn(item);
			if (this.keys.has(k)) return;
			this.keys.add(k);
		}
		this.items.push(item);
		if (!this.draining) this.drain();
	}

	/** Number of items waiting (not yet picked up by a worker). */
	get pending(): number {
		return this.items.length;
	}

	/** Whether the queue is currently processing items. */
	get isProcessing(): boolean {
		return this.draining;
	}

	// ── internals ────────────────────────────────────────────

	private drain(): void {
		this.drainAsync().catch(() => {
			// Should never happen — errors are caught per-item.
		});
	}

	private async drainAsync(): Promise<void> {
		if (this.draining) return;
		this.draining = true;

		try {
			const running: Promise<void>[] = [];

			do {
				while (this.items.length > 0) {
					await this.waitForSlot();
					if (this.items.length === 0) break;

					const item = this.items.shift()!;
					if (this.keyFn) this.keys.delete(this.keyFn(item));
					this.inflight++;

					running.push(
						this.processItem(item)
							.catch((err) => this.onError?.(err, item))
							.finally(() => this.releaseSlot()),
					);
				}

				await Promise.all(running);
				running.length = 0;
			} while (this.items.length > 0);
		} finally {
			this.draining = false;
		}
	}

	private waitForSlot(): Promise<void> {
		if (this.inflight < this.maxConcurrency) return Promise.resolve();
		return new Promise<void>((resolve) => this.slotWaiters.push(resolve));
	}

	private releaseSlot(): void {
		this.inflight--;
		const waiter = this.slotWaiters.shift();
		if (waiter) waiter();
	}
}
