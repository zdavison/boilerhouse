import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import type { InstanceId, IdleAction } from "@boilerhouse/core";
import { IdleMonitor } from "./idle-monitor";

const POLL_INTERVAL = 25;
const TIMEOUT = 50;

let monitor: IdleMonitor;
let firedEvents: Array<{ instanceId: InstanceId; action: IdleAction }>;

beforeEach(() => {
	monitor = new IdleMonitor({ defaultPollIntervalMs: POLL_INTERVAL });
	firedEvents = [];
	monitor.onIdle(async (instanceId, action) => {
		firedEvents.push({ instanceId, action });
	});
});

afterEach(() => {
	monitor.stop();
});

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("IdleMonitor", () => {
	test("watch() starts tracking — timer fires after timeout", async () => {
		const id = "inst-1" as InstanceId;
		monitor.watch(id, { timeoutMs: TIMEOUT, action: "hibernate" });

		await sleep(TIMEOUT + 20);

		expect(firedEvents).toHaveLength(1);
		expect(firedEvents[0]!.instanceId).toBe(id);
	});

	test("unwatch() stops tracking — handler never fires", async () => {
		const id = "inst-2" as InstanceId;
		monitor.watch(id, { timeoutMs: TIMEOUT, action: "hibernate" });
		monitor.unwatch(id);

		await sleep(TIMEOUT + 20);

		expect(firedEvents).toHaveLength(0);
	});

	test("reporting a newer mtime resets the idle timer", async () => {
		const id = "inst-3" as InstanceId;
		monitor.watch(id, { timeoutMs: TIMEOUT, action: "hibernate" });

		// Report activity at 30ms (before 50ms timeout)
		await sleep(30);
		monitor.reportActivity(id, new Date(1000));

		// Wait another 30ms — would have fired at 50ms without reset
		await sleep(30);
		expect(firedEvents).toHaveLength(0);

		// Wait for full timeout after reset
		await sleep(TIMEOUT);
		expect(firedEvents).toHaveLength(1);
	});

	test("timer expiry with action='hibernate' calls handler with 'hibernate'", async () => {
		const id = "inst-4" as InstanceId;
		monitor.watch(id, { timeoutMs: TIMEOUT, action: "hibernate" });

		await sleep(TIMEOUT + 20);

		expect(firedEvents).toHaveLength(1);
		expect(firedEvents[0]!.action).toBe("hibernate");
	});

	test("timer expiry with action='destroy' calls handler with 'destroy'", async () => {
		const id = "inst-5" as InstanceId;
		monitor.watch(id, { timeoutMs: TIMEOUT, action: "destroy" });

		await sleep(TIMEOUT + 20);

		expect(firedEvents).toHaveLength(1);
		expect(firedEvents[0]!.action).toBe("destroy");
	});

	test("multiple instances tracked independently (different timeouts)", async () => {
		const fast = "inst-fast" as InstanceId;
		const slow = "inst-slow" as InstanceId;

		monitor.watch(fast, { timeoutMs: TIMEOUT, action: "hibernate" });
		monitor.watch(slow, { timeoutMs: TIMEOUT * 3, action: "destroy" });

		// Fast should fire, slow should not yet
		await sleep(TIMEOUT + 20);
		expect(firedEvents).toHaveLength(1);
		expect(firedEvents[0]!.instanceId).toBe(fast);

		// Now slow fires
		await sleep(TIMEOUT * 3);
		expect(firedEvents).toHaveLength(2);
		expect(firedEvents[1]!.instanceId).toBe(slow);
	});

	test("unwatch() during active timer cancels cleanly", async () => {
		const id = "inst-cancel" as InstanceId;
		monitor.watch(id, { timeoutMs: TIMEOUT, action: "hibernate" });

		// Report some activity so timers are actively running
		monitor.reportActivity(id, new Date(500));

		await sleep(20);
		monitor.unwatch(id);

		await sleep(TIMEOUT + 20);
		expect(firedEvents).toHaveLength(0);
	});

	test("no heartbeat for 2 * pollInterval → treats as idle (guest crash)", async () => {
		const id = "inst-crash" as InstanceId;
		// Use a very long idle timeout so only heartbeat can trigger
		monitor.watch(id, { timeoutMs: 10_000, action: "hibernate" });

		// Report one activity to start heartbeat
		monitor.reportActivity(id, new Date(100));

		// Wait for heartbeat deadline (2 * pollInterval)
		await sleep(POLL_INTERVAL * 2 + 20);

		expect(firedEvents).toHaveLength(1);
		expect(firedEvents[0]!.instanceId).toBe(id);
	});

	test("watch() on already-watched instance replaces config", async () => {
		const id = "inst-replace" as InstanceId;

		// First watch with long timeout
		monitor.watch(id, { timeoutMs: 10_000, action: "hibernate" });

		// Replace with short timeout and different action
		monitor.watch(id, { timeoutMs: TIMEOUT, action: "destroy" });

		await sleep(TIMEOUT + 20);

		expect(firedEvents).toHaveLength(1);
		expect(firedEvents[0]!.action).toBe("destroy");
	});
});
