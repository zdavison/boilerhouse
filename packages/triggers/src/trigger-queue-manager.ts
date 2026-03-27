import { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";
import { randomUUID } from "node:crypto";
import type { Dispatcher, DispatchResult, TriggerEvent } from "./dispatcher";
import type { DriverMap } from "./driver";
import type { TriggerDefinition } from "./config";

export interface QueueJobData {
	triggerName: string;
	tenantId: string;
	workload: string;
	payload: unknown;
	respondCallbackId: string | null;
}

type RespondFn = (response: unknown) => Promise<void>;

export interface TriggerQueueDepth {
	trigger: string;
	waiting: number;
	active: number;
	delayed: number;
}

export class TriggerQueueManager {
	private queues = new Map<string, Queue<QueueJobData>>();
	private workers = new Map<string, Worker<QueueJobData>>();
	private respondCallbacks = new Map<string, RespondFn>();
	private cachedDepths: TriggerQueueDepth[] = [];
	private pollTimer: ReturnType<typeof setInterval> | null = null;

	constructor(
		private redis: Redis,
		private dispatcher: Dispatcher,
		private driverMap: DriverMap,
	) {
		// Poll queue depths every 10s for metrics
		this.pollTimer = setInterval(() => this.pollQueueDepths(), 10_000);
	}

	/** Returns cached queue depths (updated every 10s). */
	getQueueDepths(): TriggerQueueDepth[] {
		return this.cachedDepths;
	}

	private async pollQueueDepths(): Promise<void> {
		const depths: TriggerQueueDepth[] = [];
		for (const [trigger, queue] of this.queues) {
			try {
				const counts = await queue.getJobCounts("waiting", "active", "delayed");
				depths.push({
					trigger,
					waiting: counts.waiting ?? 0,
					active: counts.active ?? 0,
					delayed: counts.delayed ?? 0,
				});
			} catch {
				// Redis unavailable — keep stale data
			}
		}
		this.cachedDepths = depths;
	}

	register(trigger: TriggerDefinition): void {
		const queueName = `trigger-${trigger.name}`;

		const queue = new Queue<QueueJobData>(queueName, {
			connection: this.redis,
		});

		const worker = new Worker<QueueJobData>(
			queueName,
			async (job) => {
				const data = job.data;

				// Reconstruct TriggerEvent
				const event: TriggerEvent = {
					triggerName: data.triggerName,
					tenantId: data.tenantId,
					workload: data.workload,
					payload: data.payload,
				};

				// Attach respond callback from in-memory map
				if (data.respondCallbackId) {
					const respond = this.respondCallbacks.get(data.respondCallbackId);
					if (respond) {
						event.respond = respond;
					}
				}

				// Attach driver from DriverMap
				const driverEntry = this.driverMap.get(data.triggerName);
				if (driverEntry) {
					event.driver = driverEntry.driver;
					event.driverConfig = driverEntry.driverConfig;
				}

				try {
					await this.dispatcher.dispatch(event);
				} finally {
					// Clean up callback on completion (success or final failure)
					if (data.respondCallbackId) {
						this.respondCallbacks.delete(data.respondCallbackId);
					}
				}
			},
			{
				connection: this.redis,
				concurrency: 5,
				settings: {
					backoffStrategy: (attemptsMade: number) => {
						// Exponential: 2s, 4s, 8s, 16s
						return Math.pow(2, attemptsMade) * 1000;
					},
				},
			},
		);

		// Only retry on 502/504 (container not ready / claim failed)
		worker.on("failed", (job, err) => {
			if (job && job.attemptsMade >= 5) {
				// All attempts exhausted — log and clean up
				console.error(
					`[trigger-queue] Job ${job.id} for trigger ${job.data.triggerName} exhausted all retries`,
					{ tenantId: job.data.tenantId, workload: job.data.workload, error: err.message },
				);
				if (job.data.respondCallbackId) {
					this.respondCallbacks.delete(job.data.respondCallbackId);
				}
			}
		});

		this.queues.set(trigger.name, queue);
		this.workers.set(trigger.name, worker);
	}

	async enqueue(event: TriggerEvent): Promise<void> {
		const queue = this.queues.get(event.triggerName);
		if (!queue) {
			throw new Error(`No queue registered for trigger '${event.triggerName}'`);
		}

		let respondCallbackId: string | null = null;
		if (event.respond) {
			respondCallbackId = randomUUID();
			this.respondCallbacks.set(respondCallbackId, event.respond);
		}

		const jobData: QueueJobData = {
			triggerName: event.triggerName,
			tenantId: event.tenantId,
			workload: event.workload,
			payload: event.payload,
			respondCallbackId,
		};

		await queue.add(event.triggerName, jobData, {
			attempts: 5,
			backoff: { type: "custom" },
			removeOnComplete: 100,
			removeOnFail: 500,
		});
	}

	async close(): Promise<void> {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}

		const closing: Promise<void>[] = [];

		for (const worker of this.workers.values()) {
			closing.push(worker.close());
		}
		for (const queue of this.queues.values()) {
			closing.push(queue.close());
		}

		await Promise.all(closing);
		this.respondCallbacks.clear();
	}
}

export class QueuedDispatcher {
	constructor(private qm: TriggerQueueManager) {}

	async dispatch(event: TriggerEvent): Promise<DispatchResult> {
		await this.qm.enqueue(event);
		return { agentResponse: null, instanceId: "queued" };
	}
}
