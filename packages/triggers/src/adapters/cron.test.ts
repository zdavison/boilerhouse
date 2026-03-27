import { test, expect, beforeAll, afterAll } from "bun:test";
import { Cron } from "croner";
import { CronAdapter } from "./cron";
import { Dispatcher } from "../dispatcher";
import type { DispatcherDeps } from "../dispatcher";
import type { TriggerDefinition, CronConfig } from "../config";
import type { DriverMap, Driver, DriverConfig } from "../driver";

// --- croner sanity checks ---

test("croner parses standard 5-field expressions", () => {
	const job = new Cron("*/5 * * * *");
	const next = job.nextRun();
	expect(next).toBeInstanceOf(Date);
	expect(next!.getTime()).toBeGreaterThan(Date.now());
});

test("croner rejects invalid expressions", () => {
	expect(() => new Cron("bad")).toThrow();
});

test("croner handles day-of-week and month fields", () => {
	// Every Monday at 9:00
	const job = new Cron("0 9 * * 1");
	const next = job.nextRun();
	expect(next).toBeInstanceOf(Date);
	expect(next!.getDay()).toBe(1);
});

// --- CronAdapter tests ---

let agentServer: ReturnType<typeof Bun.serve>;

function createTestDeps(): DispatcherDeps {
	return {
		async claim(tenantId) {
			return {
				tenantId,
				instanceId: "i-1",
				endpoint: { host: "localhost", ports: [agentServer.port!] },
				source: "warm",
				latencyMs: 10,
			};
		},
		logActivity() {},
	};
}

beforeAll(() => {
	agentServer = Bun.serve({
		port: 0,
		async fetch() {
			return Response.json({ reply: "cron ok" });
		},
	});
});

afterAll(() => {
	agentServer.stop(true);
});

function makeCronTrigger(schedule: string): TriggerDefinition & { config: CronConfig } {
	return {
		name: "cron-test",
		type: "cron",
		tenant: { static: "reporting" },
		workload: "w-1",
		config: {
			schedule,
			payload: { type: "scheduled" },
		},
	};
}

test("CronAdapter starts and can be stopped", () => {
	const dispatcher = new Dispatcher(createTestDeps(), { waitForReady: false });
	const adapter = new CronAdapter();

	adapter.start([makeCronTrigger("*/1 * * * *")], dispatcher);
	adapter.stop();
});

test("CronAdapter stop clears all jobs", () => {
	const dispatcher = new Dispatcher(createTestDeps(), { waitForReady: false });
	const adapter = new CronAdapter();

	adapter.start(
		[
			makeCronTrigger("*/5 * * * *"),
			{ ...makeCronTrigger("0 * * * *"), name: "cron-2" },
		],
		dispatcher,
	);

	adapter.stop();

	// Verify stop is idempotent
	adapter.stop();
});

test("CronAdapter rejects invalid cron expressions", () => {
	const dispatcher = new Dispatcher(createTestDeps(), { waitForReady: false });
	const adapter = new CronAdapter();

	expect(() => adapter.start([makeCronTrigger("not valid")], dispatcher)).toThrow();
});

test("CronAdapter passes driver map through to dispatcher", () => {
	const mockDriver: Driver = {
		async send(endpoint, payload) {
			endpoint.ws!.send(payload);
			return endpoint.ws!.expect();
		},
	};
	const driverConfig: DriverConfig = { options: { key: "val" } };
	const driverMap: DriverMap = new Map([
		["cron-test", { driver: mockDriver, driverConfig }],
	]);

	const dispatcher = new Dispatcher(createTestDeps(), { waitForReady: false });
	const adapter = new CronAdapter();

	// Should not throw when passing driverMap
	adapter.start([makeCronTrigger("*/5 * * * *")], dispatcher, driverMap);
	adapter.stop();
});

test("CronAdapter builds TriggerPayload with source cron and static payload", async () => {
	let capturedPayload: unknown = null;
	const captureServer = Bun.serve({
		port: 0,
		async fetch(req) {
			capturedPayload = await req.json();
			return Response.json({ ok: true });
		},
	});

	const captureDeps: DispatcherDeps = {
		async claim(tenantId) {
			return {
				tenantId,
				instanceId: "i-1",
				endpoint: { host: "localhost", ports: [captureServer.port!] },
				source: "warm",
				latencyMs: 10,
			};
		},
		logActivity() {},
	};

	const dispatcher = new Dispatcher(captureDeps, { waitForReady: false });

	// Directly test the payload shape by triggering a cron immediately
	// We'll use a cron expression that fires every second
	const adapter = new CronAdapter();
	adapter.start(
		[makeCronTrigger("* * * * * *")], // every second (6-field croner)
		dispatcher,
	);

	// Wait for cron to fire
	await new Promise((r) => setTimeout(r, 1500));
	adapter.stop();

	expect(capturedPayload).not.toBeNull();
	const payload = capturedPayload as Record<string, unknown>;
	expect(payload.text).toBe("");
	expect(payload.senderId).toBe("cron");
	expect(payload.channelId).toBe("");
	expect(payload.source).toBe("cron");
	expect(payload.raw).toEqual({ type: "scheduled" });

	captureServer.stop(true);
});
