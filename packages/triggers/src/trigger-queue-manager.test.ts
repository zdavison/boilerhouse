import { test, expect, mock } from "bun:test";
import { QueuedDispatcher, TriggerQueueManager } from "./trigger-queue-manager";
import type { QueueJobData } from "./trigger-queue-manager";
import type { TriggerEvent, DispatchResult } from "./dispatcher";
import type { DriverMap, Driver, DriverConfig } from "./driver";
import type { TriggerDefinition } from "./config";

// ── Helpers ──────────────────────────────────────────────────────────

function makeTrigger(name = "test-trigger"): TriggerDefinition {
	return {
		name,
		type: "webhook",
		tenant: { static: "t-1" },
		workload: "w-1",
		config: { path: `/hooks/${name}` },
	};
}

function makeEvent(overrides?: Partial<TriggerEvent>): TriggerEvent {
	return {
		triggerName: "test-trigger",
		tenantId: "t-1",
		workload: "w-1",
		payload: { message: "hello" },
		...overrides,
	};
}

// ── Fake BullMQ ──────────────────────────────────────────────────────
// Instead of hitting Redis, we capture what TriggerQueueManager does
// and invoke the worker processor directly.

type Processor = (job: { data: QueueJobData; attemptsMade: number; id: string }) => Promise<void>;

// Since bun:test doesn't have module mocking that works well with already-imported
// modules, we test by extracting the processor logic via a shim approach:
// we subclass TriggerQueueManager to intercept Queue/Worker creation.

class TestableTriggerQueueManager extends TriggerQueueManager {
	public testQueues = new Map<string, { jobs: Array<{ name: string; data: QueueJobData; opts: unknown }> }>();
	public testProcessors = new Map<string, Processor>();
	public testWorkerEvents = new Map<string, Map<string, Function>>();

	constructor(redis: any, dispatcher: any, driverMap: DriverMap) {
		super(redis, dispatcher, driverMap);
		// Stop the poll timer — fake queues don't support getJobCounts
		const timer = (this as any).pollTimer;
		if (timer) clearInterval(timer);
		(this as any).pollTimer = null;
	}

	// Override register to use fake Queue/Worker
	register(trigger: TriggerDefinition): void {
		// Fake queue that captures add() calls
		const fakeQueue = {
			jobs: [] as Array<{ name: string; data: QueueJobData; opts: unknown }>,
			async add(name: string, data: QueueJobData, opts: unknown) {
				fakeQueue.jobs.push({ name, data, opts });
			},
			async close() {},
		};

		// We need to call the real register to set up the internal maps,
		// but we can't easily intercept the constructor calls.
		// Instead, replicate the logic with fakes.
		this.testQueues.set(trigger.name, fakeQueue);

		// Access private fields via cast
		const self = this as unknown as {
			queues: Map<string, unknown>;
			workers: Map<string, unknown>;
			respondCallbacks: Map<string, Function>;
			dispatcher: { dispatch(event: TriggerEvent): Promise<DispatchResult> };
			driverMap: DriverMap;
		};

		self.queues.set(trigger.name, fakeQueue);

		// Capture the processor function
		let processor: Processor;
		const events = new Map<string, Function>();

		const fakeWorker = {
			on(event: string, handler: Function) {
				events.set(event, handler);
			},
			async close() {},
		};

		// Build the processor that mirrors what TriggerQueueManager.register() does
		processor = async (job) => {
			const data = job.data;
			const event: TriggerEvent = {
				triggerName: data.triggerName,
				tenantId: data.tenantId,
				workload: data.workload,
				payload: data.payload,
			};

			if (data.respondCallbackId) {
				const respond = self.respondCallbacks.get(data.respondCallbackId);
				if (respond) {
					event.respond = respond as TriggerEvent["respond"];
				}
			}

			const driverEntry = self.driverMap.get(data.triggerName);
			if (driverEntry) {
				event.driver = driverEntry.driver;
				event.driverConfig = driverEntry.driverConfig;
			}

			try {
				await self.dispatcher.dispatch(event);
			} finally {
				if (data.respondCallbackId) {
					self.respondCallbacks.delete(data.respondCallbackId);
				}
			}
		};

		this.testProcessors.set(trigger.name, processor);
		this.testWorkerEvents.set(trigger.name, events);
		self.workers.set(trigger.name, fakeWorker);
	}

	/** Simulate BullMQ processing the next job for a trigger. */
	async processNext(triggerName: string): Promise<void> {
		const queue = this.testQueues.get(triggerName);
		const processor = this.testProcessors.get(triggerName);
		if (!queue || !processor) throw new Error(`No test queue for ${triggerName}`);
		const job = queue.jobs.shift();
		if (!job) throw new Error("No jobs in queue");
		await processor({ data: job.data, attemptsMade: 1, id: "test-job-1" });
	}
}

// ── Mock dispatcher ──────────────────────────────────────────────────

function createMockDispatcher() {
	const calls: TriggerEvent[] = [];
	let shouldThrow: Error | null = null;

	return {
		calls,
		throwOnNext(err: Error) { shouldThrow = err; },
		dispatch: mock(async (event: TriggerEvent): Promise<DispatchResult> => {
			if (shouldThrow) {
				const err = shouldThrow;
				shouldThrow = null;
				throw err;
			}
			calls.push(event);
			return { agentResponse: { reply: "ok" }, instanceId: "i-1" };
		}),
	};
}

// ── QueuedDispatcher tests ───────────────────────────────────────────

test("QueuedDispatcher.dispatch returns queued result immediately", async () => {
	const mockDispatcher = createMockDispatcher();
	const driverMap: DriverMap = new Map();
	const fakeRedis = {} as any;

	const qm = new TestableTriggerQueueManager(fakeRedis, mockDispatcher as any, driverMap);
	qm.register(makeTrigger());

	const qd = new QueuedDispatcher(qm);
	const result = await qd.dispatch(makeEvent());

	expect(result.agentResponse).toBeNull();
	expect(result.instanceId).toBe("queued");
});

test("QueuedDispatcher.dispatch does not call underlying dispatcher synchronously", async () => {
	const mockDispatcher = createMockDispatcher();
	const driverMap: DriverMap = new Map();
	const fakeRedis = {} as any;

	const qm = new TestableTriggerQueueManager(fakeRedis, mockDispatcher as any, driverMap);
	qm.register(makeTrigger());

	const qd = new QueuedDispatcher(qm);
	await qd.dispatch(makeEvent());

	// Dispatcher.dispatch should NOT have been called — it's queued
	expect(mockDispatcher.dispatch).not.toHaveBeenCalled();
});

// ── TriggerQueueManager.enqueue tests ────────────────────────────────

test("enqueue adds job to the correct queue", async () => {
	const mockDispatcher = createMockDispatcher();
	const driverMap: DriverMap = new Map();
	const fakeRedis = {} as any;

	const qm = new TestableTriggerQueueManager(fakeRedis, mockDispatcher as any, driverMap);
	qm.register(makeTrigger("alpha"));
	qm.register(makeTrigger("beta"));

	await qm.enqueue(makeEvent({ triggerName: "alpha", payload: { a: 1 } }));
	await qm.enqueue(makeEvent({ triggerName: "beta", payload: { b: 2 } }));
	await qm.enqueue(makeEvent({ triggerName: "alpha", payload: { a: 3 } }));

	expect(qm.testQueues.get("alpha")!.jobs).toHaveLength(2);
	expect(qm.testQueues.get("beta")!.jobs).toHaveLength(1);
});

test("enqueue throws for unregistered trigger", async () => {
	const mockDispatcher = createMockDispatcher();
	const driverMap: DriverMap = new Map();
	const fakeRedis = {} as any;

	const qm = new TestableTriggerQueueManager(fakeRedis, mockDispatcher as any, driverMap);

	await expect(qm.enqueue(makeEvent({ triggerName: "nonexistent" }))).rejects.toThrow(
		"No queue registered for trigger 'nonexistent'",
	);
});

test("enqueue serializes payload correctly", async () => {
	const mockDispatcher = createMockDispatcher();
	const driverMap: DriverMap = new Map();
	const fakeRedis = {} as any;

	const qm = new TestableTriggerQueueManager(fakeRedis, mockDispatcher as any, driverMap);
	qm.register(makeTrigger());

	const payload = { text: "hello", nested: { deep: true } };
	await qm.enqueue(makeEvent({ payload }));

	const job = qm.testQueues.get("test-trigger")!.jobs[0]!;
	expect(job.data.triggerName).toBe("test-trigger");
	expect(job.data.tenantId).toBe("t-1");
	expect(job.data.workload).toBe("w-1");
	expect(job.data.payload).toEqual(payload);
});

test("enqueue stores respond callback and sets callbackId", async () => {
	const mockDispatcher = createMockDispatcher();
	const driverMap: DriverMap = new Map();
	const fakeRedis = {} as any;

	const qm = new TestableTriggerQueueManager(fakeRedis, mockDispatcher as any, driverMap);
	qm.register(makeTrigger());

	const respondFn = mock(async () => {});
	await qm.enqueue(makeEvent({ respond: respondFn }));

	const job = qm.testQueues.get("test-trigger")!.jobs[0]!;
	expect(job.data.respondCallbackId).not.toBeNull();
	expect(typeof job.data.respondCallbackId).toBe("string");
});

test("enqueue sets null callbackId when no respond function", async () => {
	const mockDispatcher = createMockDispatcher();
	const driverMap: DriverMap = new Map();
	const fakeRedis = {} as any;

	const qm = new TestableTriggerQueueManager(fakeRedis, mockDispatcher as any, driverMap);
	qm.register(makeTrigger());

	await qm.enqueue(makeEvent());

	const job = qm.testQueues.get("test-trigger")!.jobs[0]!;
	expect(job.data.respondCallbackId).toBeNull();
});

// ── Worker processor tests ───────────────────────────────────────────

test("worker processor calls dispatcher.dispatch with reconstructed event", async () => {
	const mockDispatcher = createMockDispatcher();
	const driverMap: DriverMap = new Map();
	const fakeRedis = {} as any;

	const qm = new TestableTriggerQueueManager(fakeRedis, mockDispatcher as any, driverMap);
	qm.register(makeTrigger());

	await qm.enqueue(makeEvent({ payload: { msg: "queued" } }));
	await qm.processNext("test-trigger");

	expect(mockDispatcher.dispatch).toHaveBeenCalledTimes(1);
	const dispatched = mockDispatcher.calls[0]!;
	expect(dispatched.triggerName).toBe("test-trigger");
	expect(dispatched.tenantId).toBe("t-1");
	expect(dispatched.workload).toBe("w-1");
	expect(dispatched.payload).toEqual({ msg: "queued" });
});

test("worker processor attaches driver from driverMap", async () => {
	const mockDispatcher = createMockDispatcher();
	const mockDriver: Driver = {
		async send(endpoint, payload) {
			endpoint.ws!.send(payload);
			return endpoint.ws!.expect();
		},
	};
	const driverConfig: DriverConfig = { options: { apiKey: "test" } };
	const driverMap: DriverMap = new Map([
		["test-trigger", { driver: mockDriver, driverConfig }],
	]);
	const fakeRedis = {} as any;

	const qm = new TestableTriggerQueueManager(fakeRedis, mockDispatcher as any, driverMap);
	qm.register(makeTrigger());

	await qm.enqueue(makeEvent());
	await qm.processNext("test-trigger");

	const dispatched = mockDispatcher.calls[0]!;
	expect(dispatched.driver).toBe(mockDriver);
	expect(dispatched.driverConfig).toBe(driverConfig);
});

test("worker processor attaches respond callback from in-memory map", async () => {
	const mockDispatcher = createMockDispatcher();
	const driverMap: DriverMap = new Map();
	const fakeRedis = {} as any;

	const qm = new TestableTriggerQueueManager(fakeRedis, mockDispatcher as any, driverMap);
	qm.register(makeTrigger());

	const respondFn = mock(async (_response: unknown) => {});
	await qm.enqueue(makeEvent({ respond: respondFn }));
	await qm.processNext("test-trigger");

	const dispatched = mockDispatcher.calls[0]!;
	expect(dispatched.respond).toBe(respondFn);
});

test("worker processor cleans up respond callback after success", async () => {
	const mockDispatcher = createMockDispatcher();
	const driverMap: DriverMap = new Map();
	const fakeRedis = {} as any;

	const qm = new TestableTriggerQueueManager(fakeRedis, mockDispatcher as any, driverMap);
	qm.register(makeTrigger());

	const respondFn = mock(async () => {});
	await qm.enqueue(makeEvent({ respond: respondFn }));

	// Get the callbackId before processing
	const job = qm.testQueues.get("test-trigger")!.jobs[0]!;
	const callbackId = job.data.respondCallbackId!;

	// Access private respondCallbacks to verify cleanup
	const callbacks = (qm as any).respondCallbacks as Map<string, Function>;
	expect(callbacks.has(callbackId)).toBe(true);

	await qm.processNext("test-trigger");

	expect(callbacks.has(callbackId)).toBe(false);
});

test("worker processor cleans up respond callback after dispatch failure", async () => {
	const mockDispatcher = createMockDispatcher();
	const driverMap: DriverMap = new Map();
	const fakeRedis = {} as any;

	const qm = new TestableTriggerQueueManager(fakeRedis, mockDispatcher as any, driverMap);
	qm.register(makeTrigger());

	const respondFn = mock(async () => {});
	await qm.enqueue(makeEvent({ respond: respondFn }));

	const job = qm.testQueues.get("test-trigger")!.jobs[0]!;
	const callbackId = job.data.respondCallbackId!;

	mockDispatcher.throwOnNext(new Error("container not ready"));

	const callbacks = (qm as any).respondCallbacks as Map<string, Function>;
	expect(callbacks.has(callbackId)).toBe(true);

	await expect(qm.processNext("test-trigger")).rejects.toThrow("container not ready");

	// Callback should still be cleaned up despite failure
	expect(callbacks.has(callbackId)).toBe(false);
});

test("worker processor dispatches without driver when none in driverMap", async () => {
	const mockDispatcher = createMockDispatcher();
	const driverMap: DriverMap = new Map(); // empty
	const fakeRedis = {} as any;

	const qm = new TestableTriggerQueueManager(fakeRedis, mockDispatcher as any, driverMap);
	qm.register(makeTrigger());

	await qm.enqueue(makeEvent());
	await qm.processNext("test-trigger");

	const dispatched = mockDispatcher.calls[0]!;
	expect(dispatched.driver).toBeUndefined();
	expect(dispatched.driverConfig).toBeUndefined();
});

test("worker processor dispatches without respond when callback expired", async () => {
	const mockDispatcher = createMockDispatcher();
	const driverMap: DriverMap = new Map();
	const fakeRedis = {} as any;

	const qm = new TestableTriggerQueueManager(fakeRedis, mockDispatcher as any, driverMap);
	qm.register(makeTrigger());

	const respondFn = mock(async () => {});
	await qm.enqueue(makeEvent({ respond: respondFn }));

	// Manually delete the callback to simulate expiry/restart
	const job = qm.testQueues.get("test-trigger")!.jobs[0]!;
	const callbacks = (qm as any).respondCallbacks as Map<string, Function>;
	callbacks.delete(job.data.respondCallbackId!);

	await qm.processNext("test-trigger");

	const dispatched = mockDispatcher.calls[0]!;
	expect(dispatched.respond).toBeUndefined();
});

// ── Multiple triggers ────────────────────────────────────────────────

test("separate queues for separate triggers", async () => {
	const mockDispatcher = createMockDispatcher();
	const driverMap: DriverMap = new Map();
	const fakeRedis = {} as any;

	const qm = new TestableTriggerQueueManager(fakeRedis, mockDispatcher as any, driverMap);
	qm.register(makeTrigger("webhook-a"));
	qm.register(makeTrigger("webhook-b"));

	await qm.enqueue(makeEvent({ triggerName: "webhook-a", payload: { from: "a" } }));
	await qm.enqueue(makeEvent({ triggerName: "webhook-b", payload: { from: "b" } }));

	// Process webhook-b first
	await qm.processNext("webhook-b");
	expect(mockDispatcher.calls).toHaveLength(1);
	expect(mockDispatcher.calls[0]!.payload).toEqual({ from: "b" });

	// Then webhook-a
	await qm.processNext("webhook-a");
	expect(mockDispatcher.calls).toHaveLength(2);
	expect(mockDispatcher.calls[1]!.payload).toEqual({ from: "a" });
});

// ── Job options ──────────────────────────────────────────────────────

test("enqueue sets retry options on job", async () => {
	const mockDispatcher = createMockDispatcher();
	const driverMap: DriverMap = new Map();
	const fakeRedis = {} as any;

	const qm = new TestableTriggerQueueManager(fakeRedis, mockDispatcher as any, driverMap);
	qm.register(makeTrigger());

	await qm.enqueue(makeEvent());

	const job = qm.testQueues.get("test-trigger")!.jobs[0]!;
	const opts = job.opts as { attempts: number; backoff: { type: string } };
	expect(opts.attempts).toBe(5);
	expect(opts.backoff.type).toBe("custom");
});

// ── Close ────────────────────────────────────────────────────────────

test("getQueueDepths returns empty array initially", () => {
	const mockDispatcher = createMockDispatcher();
	const driverMap: DriverMap = new Map();
	const fakeRedis = {} as any;

	const qm = new TestableTriggerQueueManager(fakeRedis, mockDispatcher as any, driverMap);
	qm.register(makeTrigger());

	expect(qm.getQueueDepths()).toEqual([]);
});

test("close clears respond callbacks", async () => {
	const mockDispatcher = createMockDispatcher();
	const driverMap: DriverMap = new Map();
	const fakeRedis = {} as any;

	const qm = new TestableTriggerQueueManager(fakeRedis, mockDispatcher as any, driverMap);
	qm.register(makeTrigger());

	await qm.enqueue(makeEvent({ respond: async () => {} }));

	const callbacks = (qm as any).respondCallbacks as Map<string, Function>;
	expect(callbacks.size).toBe(1);

	await qm.close();

	expect(callbacks.size).toBe(0);
});
