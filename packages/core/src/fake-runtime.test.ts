import { describe, expect, test } from "bun:test";
import { FakeRuntime } from "./fake-runtime";
import { generateInstanceId, generateSnapshotId, generateWorkloadId, generateNodeId } from "./types";
import type { SnapshotRef } from "./snapshot";
import type { Workload } from "./workload";

function minimalWorkload(): Workload {
	return {
		workload: { name: "test-service", version: "1.0.0" },
		image: { ref: "test:latest" },
		resources: { vcpus: 1, memory_mb: 256, disk_gb: 2 },
		network: { access: "none" },
		idle: { action: "hibernate" },
	};
}

describe("FakeRuntime", () => {
	test("create() returns a handle with a unique instanceId", async () => {
		const runtime = new FakeRuntime();
		const instanceId = generateInstanceId();
		const handle = await runtime.create(minimalWorkload(), instanceId);

		expect(handle.instanceId).toBe(instanceId);
		expect(handle.running).toBe(false);
	});

	test("start() transitions handle to running", async () => {
		const runtime = new FakeRuntime();
		const handle = await runtime.create(minimalWorkload(), generateInstanceId());

		expect(handle.running).toBe(false);
		await runtime.start(handle);
		expect(handle.running).toBe(true);
	});

	test("destroy() removes the instance", async () => {
		const runtime = new FakeRuntime();
		const handle = await runtime.create(minimalWorkload(), generateInstanceId());
		await runtime.start(handle);
		await runtime.destroy(handle);

		// Subsequent operations on the destroyed handle should throw
		await expect(runtime.start(handle)).rejects.toThrow(/destroyed/i);
	});

	test("snapshot() returns a SnapshotRef with paths", async () => {
		const runtime = new FakeRuntime();
		const handle = await runtime.create(minimalWorkload(), generateInstanceId());
		await runtime.start(handle);

		const ref = await runtime.snapshot(handle);

		expect(ref.id).toBeDefined();
		expect(ref.type).toBe("tenant");
		expect(ref.paths.memory).toContain("memory");
		expect(ref.paths.vmstate).toContain("vmstate");
		expect(ref.workloadId).toBeDefined();
		expect(ref.nodeId).toBeDefined();
		expect(ref.runtimeMeta.runtimeVersion).toBeDefined();
	});

	test("restore() from a valid SnapshotRef returns a running handle", async () => {
		const runtime = new FakeRuntime();
		const handle = await runtime.create(minimalWorkload(), generateInstanceId());
		await runtime.start(handle);

		const ref = await runtime.snapshot(handle);
		const newInstanceId = generateInstanceId();
		const restored = await runtime.restore(ref, newInstanceId);

		expect(restored.instanceId).toBe(newInstanceId);
		expect(restored.running).toBe(true);
	});

	test("restore() from an invalid SnapshotRef throws", async () => {
		const runtime = new FakeRuntime();
		const invalidRef: SnapshotRef = {
			id: generateSnapshotId(),
			type: "golden",
			paths: { memory: "/nonexistent/memory", vmstate: "/nonexistent/vmstate" },
			workloadId: generateWorkloadId(),
			nodeId: generateNodeId(),
			runtimeMeta: {
				runtimeVersion: "fake-1.0.0",
				cpuTemplate: "none",
				architecture: "x86_64",
			},
		};

		await expect(
			runtime.restore(invalidRef, generateInstanceId()),
		).rejects.toThrow(/snapshot not found/i);
	});

	test("getEndpoint() returns a predictable host:port", async () => {
		const runtime = new FakeRuntime();
		const handle = await runtime.create(minimalWorkload(), generateInstanceId());
		await runtime.start(handle);

		const endpoint = await runtime.getEndpoint(handle);

		expect(endpoint.host).toBe("127.0.0.1");
		expect(endpoint.ports.length).toBeGreaterThan(0);
		expect(endpoint.ports[0]).toBeGreaterThan(0);
	});

	test("available() returns true", async () => {
		const runtime = new FakeRuntime();
		expect(await runtime.available()).toBe(true);
	});

	test("operations on a destroyed instance throw", async () => {
		const runtime = new FakeRuntime();
		const handle = await runtime.create(minimalWorkload(), generateInstanceId());
		await runtime.start(handle);
		await runtime.destroy(handle);

		await expect(runtime.start(handle)).rejects.toThrow(/destroyed/i);
		await expect(runtime.destroy(handle)).rejects.toThrow(/destroyed/i);
		await expect(runtime.snapshot(handle)).rejects.toThrow(/destroyed/i);
		await expect(runtime.getEndpoint(handle)).rejects.toThrow(/destroyed/i);
	});

	test("configurable latency adds delay to operations", async () => {
		const runtime = new FakeRuntime({ latencyMs: 50 });
		const start = Date.now();
		const handle = await runtime.create(minimalWorkload(), generateInstanceId());
		const elapsed = Date.now() - start;

		expect(elapsed).toBeGreaterThanOrEqual(40); // allow small timing jitter
		expect(handle.instanceId).toBeDefined();
	});

	test("exec() returns default success result", async () => {
		const runtime = new FakeRuntime();
		const handle = await runtime.create(minimalWorkload(), generateInstanceId());
		await runtime.start(handle);

		const result = await runtime.exec(handle, ["cat", "/tmp/healthy"]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
	});

	test("exec() uses custom execResult", async () => {
		const runtime = new FakeRuntime({
			execResult: { exitCode: 1, stdout: "", stderr: "not found" },
		});
		const handle = await runtime.create(minimalWorkload(), generateInstanceId());
		await runtime.start(handle);

		const result = await runtime.exec(handle, ["cat", "/tmp/healthy"]);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe("not found");
	});

	test("exec() throws on destroyed instance", async () => {
		const runtime = new FakeRuntime();
		const handle = await runtime.create(minimalWorkload(), generateInstanceId());
		await runtime.start(handle);
		await runtime.destroy(handle);

		await expect(runtime.exec(handle, ["true"])).rejects.toThrow(/destroyed/i);
	});

	test("exec() respects failOn", async () => {
		const runtime = new FakeRuntime({
			failOn: new Set(["exec"]),
		});
		const handle = await runtime.create(minimalWorkload(), generateInstanceId());
		await runtime.start(handle);

		await expect(runtime.exec(handle, ["true"])).rejects.toThrow(/injected failure/i);
	});

	test("configurable failure injection causes operations to throw", async () => {
		const runtime = new FakeRuntime({
			failOn: new Set(["start"]),
		});
		const handle = await runtime.create(minimalWorkload(), generateInstanceId());

		await expect(runtime.start(handle)).rejects.toThrow(/injected failure/i);
	});
});
