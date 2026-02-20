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
});
