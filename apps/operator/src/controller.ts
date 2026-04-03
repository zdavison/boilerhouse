import { createLogger } from "@boilerhouse/o11y";

export interface ControllerOptions<T> {
  name: string;
  reconcile: (item: T) => Promise<void>;
  maxRetries?: number;
}

interface QueueItem<T> {
  item: T;
  retries: number;
  nextAttempt: number;
}

/**
 * Generic reconcile controller with a work queue.
 * Items are enqueued from watch events and processed sequentially.
 * Failed reconciles are requeued with exponential backoff.
 */
export class Controller<T extends { metadata: { name: string; namespace?: string } }> {
  private queue: QueueItem<T>[] = [];
  private readonly reconcile: (item: T) => Promise<void>;
  private readonly maxRetries: number;
  private readonly log;
  private running = false;
  private wakeup: (() => void) | null = null;

  constructor(options: ControllerOptions<T>) {
    this.reconcile = options.reconcile;
    this.maxRetries = options.maxRetries ?? 5;
    this.log = createLogger(`controller:${options.name}`);
  }

  enqueue(item: T): void {
    // Deduplicate: if same namespace+name already in queue, replace it
    const key = `${item.metadata.namespace ?? ""}/${item.metadata.name}`;
    const idx = this.queue.findIndex(
      (q) => `${q.item.metadata.namespace ?? ""}/${q.item.metadata.name}` === key,
    );
    if (idx >= 0) {
      this.queue[idx] = { item, retries: this.queue[idx].retries, nextAttempt: Date.now() };
    } else {
      this.queue.push({ item, retries: 0, nextAttempt: Date.now() });
    }
    this.wakeup?.();
  }

  /** Process one item from the queue. Returns false if queue is empty. */
  async processOnce(): Promise<boolean> {
    const now = Date.now();
    const idx = this.queue.findIndex((q) => q.nextAttempt <= now);
    if (idx < 0) return false;

    const entry = this.queue.splice(idx, 1)[0];
    const name = entry.item.metadata.name;

    try {
      await this.reconcile(entry.item);
      this.log.debug({ name }, "reconciled");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (entry.retries >= this.maxRetries) {
        this.log.error({ name, err: msg }, "max retries exceeded, dropping");
        return true;
      }

      const backoffMs = Math.min(1000 * 2 ** entry.retries, 30_000);
      this.log.warn({ name, err: msg, retry: entry.retries + 1, backoffMs }, "requeuing");
      this.queue.push({
        item: entry.item,
        retries: entry.retries + 1,
        nextAttempt: Date.now() + backoffMs,
      });
    }

    return true;
  }

  /** Start processing loop. Runs until stop() is called. */
  async start(signal?: AbortSignal): Promise<void> {
    this.running = true;
    while (this.running && !signal?.aborted) {
      const processed = await this.processOnce();
      if (!processed) {
        // Wait for new items — set wakeup BEFORE checking queue to avoid race:
        // an enqueue() between processOnce() returning false and wakeup being set
        // would otherwise wait up to 5s.
        await new Promise<void>((resolve) => {
          this.wakeup = resolve;
          if (this.queue.length > 0) {
            resolve();
            return;
          }
          setTimeout(resolve, 5000); // periodic wakeup
        });
        this.wakeup = null;
      }
    }
  }

  stop(): void {
    this.running = false;
    this.wakeup?.();
  }

  get queueDepth(): number {
    return this.queue.length;
  }
}
