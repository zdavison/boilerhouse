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

	test("stop() transitions handle to stopped", async () => {
		const runtime = new FakeRuntime();
		const handle = await runtime.create(minimalWorkload(), generateInstanceId());
		await runtime.start(handle);

		expect(handle.running).toBe(true);
		await runtime.stop(handle);
		expect(handle.running).toBe(false);
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
		expect(typeof endpoint.port).toBe("number");
		expect(endpoint.port).toBeGreaterThan(0);
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
		await expect(runtime.stop(handle)).rejects.toThrow(/destroyed/i);
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

	test("configurable failure injection causes operations to throw", async () => {
		const runtime = new FakeRuntime({
			failOn: new Set(["start"]),
		});
		const handle = await runtime.create(minimalWorkload(), generateInstanceId());

		await expect(runtime.start(handle)).rejects.toThrow(/injected failure/i);
	});
});
