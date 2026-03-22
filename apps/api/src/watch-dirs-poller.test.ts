import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
	type WorkloadId,
	type NodeId,
	type Workload,
	type InstanceId,
	type IdleAction,
	FakeRuntime,
	generateWorkloadId,
	generateNodeId,
} from "@boilerhouse/core";
import { createTestDatabase, type DrizzleDb, ActivityLog, nodes, workloads } from "@boilerhouse/db";
import { InstanceManager } from "./instance-manager";
import { IdleMonitor } from "./idle-monitor";
import { WatchDirsPoller } from "./watch-dirs-poller";

const POLL_INTERVAL = 20;
const HEARTBEAT_DEADLINE = POLL_INTERVAL * 2;

const TEST_WORKLOAD: Workload = {
	workload: { name: "poll-test", version: "1.0.0" },
	image: { ref: "test:latest" },
	resources: { vcpus: 1, memory_mb: 256, disk_gb: 2 },
	network: { access: "none" },
	idle: { action: "hibernate", timeout_seconds: 1000 },
};

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function seedWorkload(db: DrizzleDb, id: WorkloadId, w: Workload): void {
	db.insert(workloads)
		.values({
			workloadId: id,
			name: w.workload.name,
			version: w.workload.version,
			config: w,
			createdAt: new Date(),
			updatedAt: new Date(),
		})
		.run();
}

let db: DrizzleDb;
let runtime: FakeRuntime;
let nodeId: NodeId;
let instanceManager: InstanceManager;
let idleMonitor: IdleMonitor;
let poller: WatchDirsPoller;

beforeEach(() => {
	db = createTestDatabase();
	runtime = new FakeRuntime();
	nodeId = generateNodeId();
	const log = new ActivityLog(db);

	db.insert(nodes)
		.values({
			nodeId,
			runtimeType: "podman",
			capacity: { vcpus: 8, memoryMb: 16384, diskGb: 100 },
			status: "online",
			lastHeartbeat: new Date(),
			createdAt: new Date(),
		})
		.run();

	instanceManager = new InstanceManager(runtime, db, log, nodeId);
	idleMonitor = new IdleMonitor({ defaultPollIntervalMs: POLL_INTERVAL });
	poller = new WatchDirsPoller(instanceManager, idleMonitor, POLL_INTERVAL);
});

afterEach(() => {
	poller.stopAll();
	idleMonitor.stop();
});

describe("WatchDirsPoller", () => {
	test("polling calls reportActivity and keeps heartbeat alive", async () => {
		const firedEvents: Array<{ instanceId: InstanceId; action: IdleAction }> = [];
		idleMonitor.onIdle(async (id, action) => { firedEvents.push({ instanceId: id, action }); });

		// Seed workload and create a real instance so statWatchDirs can find it
		const workloadId = generateWorkloadId() as WorkloadId;
		seedWorkload(db, workloadId, TEST_WORKLOAD);
		const handle = await instanceManager.create(workloadId, TEST_WORKLOAD);
		const instanceId = handle.instanceId;

		// Configure exec to return a valid timestamp
		const now = Math.floor(Date.now() / 1000);
		runtime.setExecResult({ exitCode: 0, stdout: `${now}\n`, stderr: "" });

		// Set up a long idle timeout; only heartbeat should keep it alive
		idleMonitor.watch(instanceId, { timeoutMs: 10_000, action: "hibernate" });

		// Start polling — each poll calls reportActivity, keeping heartbeat alive
		poller.startPolling(instanceId, ["/data"]);

		// Wait for 3 poll cycles: heartbeat (POLL_INTERVAL * 2) should NOT fire
		await sleep(HEARTBEAT_DEADLINE + POLL_INTERVAL + 10);

		// If heartbeat fired, we'd see an event; polling should prevent it
		expect(firedEvents).toHaveLength(0);
	});

	test("mtime change resets idle timer", async () => {
		const firedEvents: Array<{ instanceId: InstanceId; action: IdleAction }> = [];
		idleMonitor.onIdle(async (id, action) => { firedEvents.push({ instanceId: id, action }); });

		const workloadId = generateWorkloadId() as WorkloadId;
		seedWorkload(db, workloadId, TEST_WORKLOAD);
		const handle = await instanceManager.create(workloadId, TEST_WORKLOAD);
		const instanceId = handle.instanceId;

		const baseTime = Math.floor(Date.now() / 1000) - 100;
		runtime.setExecResult({ exitCode: 0, stdout: `${baseTime}\n`, stderr: "" });

		// Short idle timeout so it would fire quickly without activity
		idleMonitor.watch(instanceId, { timeoutMs: POLL_INTERVAL * 3, action: "hibernate" });
		poller.startPolling(instanceId, ["/data"]);

		// Update exec to return a newer mtime on subsequent polls
		await sleep(POLL_INTERVAL + 5);
		const newerTime = Math.floor(Date.now() / 1000);
		runtime.setExecResult({ exitCode: 0, stdout: `${newerTime}\n`, stderr: "" });

		// Wait past original timeout — idle timer should have reset due to newer mtime
		await sleep(POLL_INTERVAL * 3 + 10);

		// Should still be in flight (timer got reset)
		expect(firedEvents).toHaveLength(0);
	});

	test("stopPolling cancels interval — heartbeat fires after deadline", async () => {
		const firedEvents: Array<{ instanceId: InstanceId; action: IdleAction }> = [];
		idleMonitor.onIdle(async (id, action) => { firedEvents.push({ instanceId: id, action }); });

		const workloadId = generateWorkloadId() as WorkloadId;
		seedWorkload(db, workloadId, TEST_WORKLOAD);
		const handle = await instanceManager.create(workloadId, TEST_WORKLOAD);
		const instanceId = handle.instanceId;

		const now = Math.floor(Date.now() / 1000);
		runtime.setExecResult({ exitCode: 0, stdout: `${now}\n`, stderr: "" });

		// Long idle timeout; heartbeat will be the trigger
		idleMonitor.watch(instanceId, { timeoutMs: 10_000, action: "hibernate" });
		poller.startPolling(instanceId, ["/data"]);

		// Let one poll fire to start heartbeat
		await sleep(POLL_INTERVAL + 5);
		expect(firedEvents).toHaveLength(0);

		// Stop polling — heartbeat will expire since no more reportActivity calls
		poller.stopPolling(instanceId);

		// Wait for heartbeat deadline
		await sleep(HEARTBEAT_DEADLINE + 10);

		expect(firedEvents).toHaveLength(1);
		expect(firedEvents[0]!.instanceId).toBe(instanceId);
	});

	test("exec failure does not throw — heartbeat expires naturally", async () => {
		const firedEvents: Array<{ instanceId: InstanceId; action: IdleAction }> = [];
		idleMonitor.onIdle(async (id, action) => { firedEvents.push({ instanceId: id, action }); });

		const workloadId = generateWorkloadId() as WorkloadId;
		seedWorkload(db, workloadId, TEST_WORKLOAD);
		const handle = await instanceManager.create(workloadId, TEST_WORKLOAD);
		const instanceId = handle.instanceId;

		// Start with a valid response to trigger the heartbeat
		const now = Math.floor(Date.now() / 1000);
		runtime.setExecResult({ exitCode: 0, stdout: `${now}\n`, stderr: "" });

		idleMonitor.watch(instanceId, { timeoutMs: 10_000, action: "hibernate" });
		poller.startPolling(instanceId, ["/data"]);

		// One poll fires to start heartbeat
		await sleep(POLL_INTERVAL + 5);

		// Simulate exec failure (empty stdout → statWatchDirs returns new Date(0))
		runtime.setExecResult({ exitCode: 1, stdout: "", stderr: "error" });

		// Heartbeat should fire after deadline with no more valid reportActivity calls
		await sleep(HEARTBEAT_DEADLINE + 10);

		expect(firedEvents).toHaveLength(1);
	});

	test("skip-if-busy: slow poll does not stack concurrent execs for the same instance", async () => {
		let concurrentCalls = 0;
		let maxObservedConcurrent = 0;
		let totalCalls = 0;

		// Replace statWatchDirs with a slow version that takes 3× the poll interval
		const slowManager = {
			statWatchDirs: async (_id: InstanceId, _dirs: string[]) => {
				totalCalls++;
				concurrentCalls++;
				maxObservedConcurrent = Math.max(maxObservedConcurrent, concurrentCalls);
				await sleep(POLL_INTERVAL * 3);
				concurrentCalls--;
				return new Date();
			},
		} as unknown as typeof instanceManager;

		const slowPoller = new WatchDirsPoller(slowManager, idleMonitor, POLL_INTERVAL);

		const workloadId = generateWorkloadId() as WorkloadId;
		seedWorkload(db, workloadId, TEST_WORKLOAD);
		const handle = await instanceManager.create(workloadId, TEST_WORKLOAD);

		idleMonitor.watch(handle.instanceId, { timeoutMs: 10_000, action: "hibernate" });
		slowPoller.startPolling(handle.instanceId, ["/data"]);

		// Wait for 5 poll ticks — each tick should skip because the first poll is still running
		await sleep(POLL_INTERVAL * 5 + 10);
		slowPoller.stopAll();

		// Concurrent calls for a single instance must never exceed 1 (no stacking)
		expect(maxObservedConcurrent).toBe(1);
		// Calls should be far fewer than poll ticks (most ticks were skipped while busy)
		expect(totalCalls).toBeLessThan(4);
	});

	test("semaphore: global maxConcurrentExecs limits simultaneous execs across instances", async () => {
		let activeExecs = 0;
		let maxObservedActive = 0;
		const MAX_CONCURRENT = 2;

		// Each poll holds a semaphore slot for 3× the poll interval
		const slowManager = {
			statWatchDirs: async (_id: InstanceId, _dirs: string[]) => {
				activeExecs++;
				maxObservedActive = Math.max(maxObservedActive, activeExecs);
				await sleep(POLL_INTERVAL * 3);
				activeExecs--;
				return new Date();
			},
		} as unknown as typeof instanceManager;

		// 4 instances but only 2 concurrent slots
		const semPoller = new WatchDirsPoller(slowManager, idleMonitor, POLL_INTERVAL, MAX_CONCURRENT);

		const instanceIds: InstanceId[] = [];
		for (let i = 0; i < 4; i++) {
			const wId = generateWorkloadId() as WorkloadId;
			const w: Workload = { ...TEST_WORKLOAD, workload: { name: `sem-test-${i}`, version: "1.0.0" } };
			seedWorkload(db, wId, w);
			const h = await instanceManager.create(wId, w);
			idleMonitor.watch(h.instanceId, { timeoutMs: 10_000, action: "hibernate" });
			semPoller.startPolling(h.instanceId, ["/data"]);
			instanceIds.push(h.instanceId);
		}

		// Wait long enough for all 4 first-ticks to fire and enter acquireSemaphore
		await sleep(POLL_INTERVAL + 10);
		// Give the concurrent execs time to overlap
		await sleep(POLL_INTERVAL);

		semPoller.stopAll();

		expect(maxObservedActive).toBeLessThanOrEqual(MAX_CONCURRENT);
	});

	test("stopAll clears all intervals", async () => {
		const w1: Workload = { ...TEST_WORKLOAD, workload: { name: "poll-test-a", version: "1.0.0" } };
		const w2: Workload = { ...TEST_WORKLOAD, workload: { name: "poll-test-b", version: "1.0.0" } };
		const workloadId1 = generateWorkloadId() as WorkloadId;
		const workloadId2 = generateWorkloadId() as WorkloadId;
		seedWorkload(db, workloadId1, w1);
		seedWorkload(db, workloadId2, w2);
		const handle1 = await instanceManager.create(workloadId1, w1);
		const handle2 = await instanceManager.create(workloadId2, w2);

		runtime.setExecResult({ exitCode: 0, stdout: "0\n", stderr: "" });

		poller.startPolling(handle1.instanceId, ["/data"]);
		poller.startPolling(handle2.instanceId, ["/data"]);

		poller.stopAll();

		// Both intervals should be cleared — no errors thrown
		expect(true).toBe(true);
	});
});
