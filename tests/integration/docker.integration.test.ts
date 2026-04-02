import { describe, test, expect, afterEach, setDefaultTimeout } from "bun:test";
import { generateInstanceId } from "@boilerhouse/core";
import type { Workload } from "@boilerhouse/core";
import { DockerRuntime } from "@boilerhouse/runtime-docker";

const DOCKER_SOCKET = process.env.DOCKER_SOCKET ?? "/var/run/docker.sock";

// Skip suite if Docker is not available.
const dockerAvailable = (() => {
	try {
		const result = Bun.spawnSync(["docker", "info"], {
			stdout: "ignore",
			stderr: "ignore",
		});
		return result.exitCode === 0;
	} catch {
		return false;
	}
})();

const ALPINE_IMAGE = "docker.io/library/alpine:3.21";

const TEST_WORKLOAD: Workload = {
	workload: { name: "integration-test", version: "1.0.0" },
	image: { ref: ALPINE_IMAGE },
	resources: { vcpus: 1, memory_mb: 128 },
	network: { access: "none" },
	idle: { action: "destroy" },
	entrypoint: {
		cmd: "/bin/sh",
		args: ["-c", "while true; do sleep 1; done"],
	},
};

const TEST_WORKLOAD_WITH_PORT: Workload = {
	workload: { name: "integration-test-port", version: "1.0.0" },
	image: { ref: ALPINE_IMAGE },
	resources: { vcpus: 1, memory_mb: 128 },
	network: {
		access: "unrestricted",
		expose: [{ guest: 8080, host_range: [0, 0] }],
	},
	idle: { action: "destroy" },
	entrypoint: {
		cmd: "/bin/sh",
		args: ["-c", "while true; do sleep 1; done"],
	},
};

const handlesToCleanup: { instanceId: string; running: boolean }[] = [];

afterEach(async () => {
	const runtime = new DockerRuntime({ socketPath: DOCKER_SOCKET });
	for (const handle of handlesToCleanup) {
		await runtime.destroy(handle).catch(() => {});
	}
	handlesToCleanup.length = 0;
});

function track(instanceId: string): void {
	handlesToCleanup.push({ instanceId, running: false });
}

describe.skipIf(!dockerAvailable)("DockerRuntime", () => {
	setDefaultTimeout(60_000);

	test("available() returns true when Docker daemon is running", async () => {
		const runtime = new DockerRuntime({ socketPath: DOCKER_SOCKET });
		expect(await runtime.available()).toBe(true);
	});

	test("create → start → destroy lifecycle", async () => {
		const runtime = new DockerRuntime({ socketPath: DOCKER_SOCKET });
		const instanceId = generateInstanceId();
		track(instanceId);

		const handle = await runtime.create(TEST_WORKLOAD, instanceId);
		expect(handle.instanceId).toBe(instanceId);
		expect(handle.running).toBe(false);

		await runtime.start(handle);
		expect(handle.running).toBe(true);

		const listed = await runtime.list();
		expect(listed).toContain(instanceId);

		await runtime.destroy(handle);
		expect(handle.running).toBe(false);

		const listedAfter = await runtime.list();
		expect(listedAfter).not.toContain(instanceId);
	});

	test("exec() runs a command inside a running container", async () => {
		const runtime = new DockerRuntime({ socketPath: DOCKER_SOCKET });
		const instanceId = generateInstanceId();
		track(instanceId);

		const handle = await runtime.create(TEST_WORKLOAD, instanceId);
		await runtime.start(handle);

		const result = await runtime.exec(handle, ["echo", "hello"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("hello");
	});

	test("getEndpoint() returns a host port for exposed containers", async () => {
		const runtime = new DockerRuntime({ socketPath: DOCKER_SOCKET });
		const instanceId = generateInstanceId();
		track(instanceId);

		const handle = await runtime.create(TEST_WORKLOAD_WITH_PORT, instanceId);
		await runtime.start(handle);

		const endpoint = await runtime.getEndpoint(handle);
		expect(endpoint.host).toBe("127.0.0.1");
		expect(endpoint.ports.length).toBeGreaterThan(0);
		expect(endpoint.ports[0]).toBeGreaterThan(0);
	});

	test("destroy() is idempotent", async () => {
		const runtime = new DockerRuntime({ socketPath: DOCKER_SOCKET });
		const instanceId = generateInstanceId();
		track(instanceId);

		const handle = await runtime.create(TEST_WORKLOAD, instanceId);
		await runtime.start(handle);
		await runtime.destroy(handle);

		// Second destroy should not throw
		await expect(runtime.destroy(handle)).resolves.toBeUndefined();
	});

	test("logs() returns output from a running container", async () => {
		const runtime = new DockerRuntime({ socketPath: DOCKER_SOCKET });
		const instanceId = generateInstanceId();
		track(instanceId);

		const workload: Workload = {
			...TEST_WORKLOAD,
			entrypoint: {
				cmd: "/bin/sh",
				args: ["-c", "echo 'hello from docker' && while true; do sleep 1; done"],
			},
		};

		const handle = await runtime.create(workload, instanceId);
		await runtime.start(handle);

		// Give the container a moment to produce output
		await new Promise((r) => setTimeout(r, 500));

		const logs = await runtime.logs!(handle);
		expect(logs).toContain("hello from docker");
	});
});
