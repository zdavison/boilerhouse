import { describe, test, expect, afterEach } from "bun:test";
import {
	pollHealth,
	createHttpCheck,
	createExecCheck,
	HealthCheckTimeoutError,
} from "./health-check";
import type { HealthConfig, HealthCheckFn } from "./health-check";
import { FakeRuntime, generateInstanceId } from "@boilerhouse/core";
import type { Workload } from "@boilerhouse/core";

let servers: Array<ReturnType<typeof Bun.serve>> = [];

function startServer(handler: (req: Request) => Response): string {
	const server = Bun.serve({
		port: 0,
		fetch: handler,
	});
	servers.push(server);
	return `http://localhost:${server.port}`;
}

function minimalWorkload(): Workload {
	return {
		workload: { name: "test-service", version: "1.0.0" },
		image: { ref: "test:latest" },
		resources: { vcpus: 1, memory_mb: 256, disk_gb: 2 },
		network: { access: "none" },
		idle: { action: "hibernate" },
	};
}

afterEach(() => {
	for (const s of servers) {
		s.stop(true);
	}
	servers = [];
});

describe("pollHealth", () => {
	test("returns success after first healthy response", async () => {
		const url = startServer(() => new Response("ok", { status: 200 }));

		const config: HealthConfig = {
			interval: 10,
			unhealthyThreshold: 5,
			timeoutMs: 1000,
		};

		await expect(
			pollHealth(createHttpCheck(`${url}/health`), config),
		).resolves.toBeUndefined();
	});

	test("polls endpoint at configured interval", async () => {
		const timestamps: number[] = [];
		let callCount = 0;

		const url = startServer(() => {
			timestamps.push(Date.now());
			callCount++;
			// Succeed on 3rd attempt
			if (callCount >= 3) {
				return new Response("ok", { status: 200 });
			}
			return new Response("not ready", { status: 503 });
		});

		const config: HealthConfig = {
			interval: 50,
			unhealthyThreshold: 10,
			timeoutMs: 5000,
		};

		await pollHealth(createHttpCheck(`${url}/health`), config);

		expect(callCount).toBeGreaterThanOrEqual(3);

		// Check that intervals between requests are roughly correct
		for (let i = 1; i < timestamps.length; i++) {
			const gap = timestamps[i]! - timestamps[i - 1]!;
			// Allow some jitter — gap should be at least interval * 0.5
			expect(gap).toBeGreaterThanOrEqual(25);
		}
	});

	test("retries on failure up to unhealthy_threshold consecutive failures", async () => {
		let callCount = 0;

		const url = startServer(() => {
			callCount++;
			return new Response("fail", { status: 500 });
		});

		const config: HealthConfig = {
			interval: 10,
			unhealthyThreshold: 3,
			timeoutMs: 10000,
		};

		await expect(
			pollHealth(createHttpCheck(`${url}/health`), config),
		).rejects.toBeInstanceOf(HealthCheckTimeoutError);

		// Should have been called exactly unhealthyThreshold times
		expect(callCount).toBe(3);
	});

	test("times out after configurable deadline", async () => {
		const url = startServer(() => new Response("fail", { status: 503 }));

		const config: HealthConfig = {
			interval: 20,
			unhealthyThreshold: 1000, // high threshold so timeout fires first
			timeoutMs: 100,
		};

		const start = Date.now();
		await expect(
			pollHealth(createHttpCheck(`${url}/health`), config),
		).rejects.toBeInstanceOf(HealthCheckTimeoutError);
		const elapsed = Date.now() - start;

		expect(elapsed).toBeGreaterThanOrEqual(80);
		expect(elapsed).toBeLessThan(500);
	});

	test("supports HTTP health endpoints (200 = healthy)", async () => {
		let callCount = 0;

		const url = startServer(() => {
			callCount++;
			// Return different status codes — only 200 is healthy
			if (callCount === 1) return new Response("", { status: 503 });
			if (callCount === 2) return new Response("", { status: 404 });
			return new Response("ok", { status: 200 });
		});

		const config: HealthConfig = {
			interval: 10,
			unhealthyThreshold: 10,
			timeoutMs: 5000,
		};

		await pollHealth(createHttpCheck(`${url}/health`), config);

		expect(callCount).toBe(3);
	});

	test("works with generic HealthCheckFn", async () => {
		let calls = 0;
		const check: HealthCheckFn = async () => {
			calls++;
			return calls >= 2;
		};

		const config: HealthConfig = {
			interval: 10,
			unhealthyThreshold: 10,
			timeoutMs: 5000,
		};

		await pollHealth(check, config);

		expect(calls).toBe(2);
	});
});

describe("createExecCheck", () => {
	test("returns true on exit code 0", async () => {
		const runtime = new FakeRuntime();
		const handle = await runtime.create(minimalWorkload(), generateInstanceId());
		await runtime.start(handle);

		const check = createExecCheck(runtime, handle, ["cat", "/tmp/healthy"]);
		const result = await check();

		expect(result).toBe(true);
	});

	test("returns false on non-zero exit code", async () => {
		const runtime = new FakeRuntime({
			execResult: { exitCode: 1, stdout: "", stderr: "fail" },
		});
		const handle = await runtime.create(minimalWorkload(), generateInstanceId());
		await runtime.start(handle);

		const check = createExecCheck(runtime, handle, ["cat", "/tmp/healthy"]);
		const result = await check();

		expect(result).toBe(false);
	});

	test("calls onLog with exit code, stdout, and stderr on failure", async () => {
		const runtime = new FakeRuntime({
			execResult: { exitCode: 127, stdout: "some output", stderr: "command not found" },
		});
		const handle = await runtime.create(minimalWorkload(), generateInstanceId());
		await runtime.start(handle);

		const logs: string[] = [];
		const check = createExecCheck(runtime, handle, ["cat", "/tmp/healthy"], (line) => logs.push(line));
		await check();

		expect(logs.length).toBe(1);
		expect(logs[0]).toContain("exitCode=127");
		expect(logs[0]).toContain("command not found");
		expect(logs[0]).toContain("some output");
	});

	test("does not call onLog on success", async () => {
		const runtime = new FakeRuntime();
		const handle = await runtime.create(minimalWorkload(), generateInstanceId());
		await runtime.start(handle);

		const logs: string[] = [];
		const check = createExecCheck(runtime, handle, ["cat", "/tmp/healthy"], (line) => logs.push(line));
		await check();

		expect(logs.length).toBe(0);
	});
});

describe("createHttpCheck", () => {
	test("calls onLog with status code on failure", async () => {
		const url = startServer(() => new Response("bad gateway", { status: 502 }));

		const logs: string[] = [];
		const check = createHttpCheck(`${url}/health`, (line) => logs.push(line));
		await check();

		expect(logs.length).toBe(1);
		expect(logs[0]).toContain("502");
	});

	test("does not call onLog on success", async () => {
		const url = startServer(() => new Response("ok", { status: 200 }));

		const logs: string[] = [];
		const check = createHttpCheck(`${url}/health`, (line) => logs.push(line));
		await check();

		expect(logs.length).toBe(0);
	});
});

describe("pollHealth onLog", () => {
	test("logs attempt info on each failure", async () => {
		let _calls = 0;
		const check: HealthCheckFn = async () => {
			_calls++;
			return false;
		};

		const config: HealthConfig = {
			interval: 10,
			unhealthyThreshold: 3,
			timeoutMs: 5000,
		};

		const logs: string[] = [];
		await expect(
			pollHealth(check, config, (line) => logs.push(line)),
		).rejects.toBeInstanceOf(HealthCheckTimeoutError);

		expect(logs.length).toBe(3);
		expect(logs[0]).toContain("attempt 1");
		expect(logs[2]).toContain("attempt 3");
		expect(logs[2]).toContain("3/3 consecutive failures");
	});

	test("logs thrown error message when check throws", async () => {
		const check: HealthCheckFn = async () => {
			throw new Error("connection refused");
		};

		const config: HealthConfig = {
			interval: 10,
			unhealthyThreshold: 2,
			timeoutMs: 5000,
		};

		const logs: string[] = [];
		await expect(
			pollHealth(check, config, (line) => logs.push(line)),
		).rejects.toBeInstanceOf(HealthCheckTimeoutError);

		// Each attempt should produce two log lines: the thrown error + the attempt summary
		const thrownLogs = logs.filter((l) => l.includes("threw:"));
		expect(thrownLogs.length).toBe(2);
		expect(thrownLogs[0]).toContain("connection refused");
	});

	test("does not log on successful attempts", async () => {
		const check: HealthCheckFn = async () => true;

		const config: HealthConfig = {
			interval: 10,
			unhealthyThreshold: 3,
			timeoutMs: 5000,
		};

		const logs: string[] = [];
		await pollHealth(check, config, (line) => logs.push(line));

		expect(logs.length).toBe(0);
	});
});
