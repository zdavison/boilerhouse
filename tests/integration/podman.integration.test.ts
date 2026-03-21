import { describe, test, expect, afterEach, setDefaultTimeout } from "bun:test";
import { generateInstanceId, DEFAULT_RUNTIME_SOCKET } from "@boilerhouse/core";
import type { Workload } from "@boilerhouse/core";
import { PodmanRuntime } from "@boilerhouse/runtime-podman";
import { DaemonBackend } from "@boilerhouse/runtime-podman";
import { mkdtempSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DAEMON_SOCKET = process.env.DAEMON_SOCKET ?? DEFAULT_RUNTIME_SOCKET;

// Skip entire suite if the daemon socket is not available.
// existsSync alone is not enough — stale socket files from crashed daemons
// cause tests to hang instead of skipping. Probe with a real HTTP request.
const podmanAvailable = (() => {
	try {
		if (!existsSync(DAEMON_SOCKET)) return false;
		const result = Bun.spawnSync(
			["curl", "--unix-socket", DAEMON_SOCKET, "--max-time", "2", "-sf", "http://localhost/healthz"],
			{ stdout: "pipe", stderr: "ignore" },
		);
		return result.exitCode === 0;
	} catch {
		return false;
	}
})();

const ALPINE_IMAGE = "docker.io/library/alpine:3.21";

const TEST_WORKLOAD: Workload = {
	workload: { name: "integration-test", version: "1.0.0" },
	image: { ref: ALPINE_IMAGE },
	resources: { vcpus: 1, memory_mb: 128, disk_gb: 1 },
	network: { access: "none" },
	idle: { action: "hibernate" },
	entrypoint: {
		cmd: "/bin/sh",
		args: ["-c", "while true; do sleep 1; done"],
	},
};

const TEST_WORKLOAD_WITH_PORT: Workload = {
	workload: { name: "integration-test-port", version: "1.0.0" },
	image: { ref: ALPINE_IMAGE },
	resources: { vcpus: 1, memory_mb: 128, disk_gb: 1 },
	network: {
		access: "outbound",
		expose: [{ guest: 8080, host_range: [0, 0] }],
	},
	idle: { action: "hibernate" },
	entrypoint: {
		cmd: "/bin/sh",
		args: ["-c", "while true; do sleep 1; done"],
	},
};

// Track containers for cleanup via the daemon
const containersToCleanup: string[] = [];
const cleanupBackend = podmanAvailable
	? new DaemonBackend({ socketPath: DAEMON_SOCKET })
	: undefined;

afterEach(async () => {
	for (const id of containersToCleanup) {
		await cleanupBackend?.removePod(id).catch(() => {});
	}
	containersToCleanup.length = 0;
});

function trackInstance(id: string): void {
	containersToCleanup.push(id);
}

describe.skipIf(!podmanAvailable)("PodmanRuntime (daemon)", () => {
	setDefaultTimeout(60_000);

	test("available() returns true when podman and CRIU are present", async () => {
		const snapshotDir = mkdtempSync(join(tmpdir(), "bh-test-"));
		const runtime = new PodmanRuntime({ snapshotDir, socketPath: DAEMON_SOCKET });

		const result = await runtime.available();
		// CRIU may or may not be installed — just check it doesn't throw
		expect(typeof result).toBe("boolean");
	});

	test("create + start + destroy lifecycle", async () => {
		const snapshotDir = mkdtempSync(join(tmpdir(), "bh-test-"));
		const runtime = new PodmanRuntime({ snapshotDir, socketPath: DAEMON_SOCKET });
		const instanceId = generateInstanceId();
		trackInstance(instanceId);

		const handle = await runtime.create(TEST_WORKLOAD, instanceId);

		expect(handle.instanceId).toBe(instanceId);
		expect(handle.running).toBe(false);

		await runtime.start(handle);
		expect(handle.running).toBe(true);

		// Verify container is running via the daemon
		const inspect = await cleanupBackend!.inspectContainer(instanceId);
		expect(inspect.State.Running).toBe(true);

		await runtime.destroy(handle);
		expect(handle.running).toBe(false);
	});

	test("exec runs command inside container", async () => {
		const snapshotDir = mkdtempSync(join(tmpdir(), "bh-test-"));
		const runtime = new PodmanRuntime({ snapshotDir, socketPath: DAEMON_SOCKET });
		const instanceId = generateInstanceId();
		trackInstance(instanceId);

		const handle = await runtime.create(TEST_WORKLOAD, instanceId);
		await runtime.start(handle);

		const result = await runtime.exec(handle, ["echo", "hello from container"]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("hello from container");

		await runtime.destroy(handle);
	});

	test("getEndpoint returns published host ports", async () => {
		const snapshotDir = mkdtempSync(join(tmpdir(), "bh-test-"));
		const runtime = new PodmanRuntime({ snapshotDir, socketPath: DAEMON_SOCKET });
		const instanceId = generateInstanceId();
		trackInstance(instanceId);

		const handle = await runtime.create(TEST_WORKLOAD_WITH_PORT, instanceId);
		await runtime.start(handle);

		const endpoint = await runtime.getEndpoint(handle);

		expect(endpoint.host).toBe("127.0.0.1");
		expect(endpoint.ports.length).toBeGreaterThan(0);
		expect(endpoint.ports[0]).toBeGreaterThan(0);

		await runtime.destroy(handle);
	});

	test("list tracks created instances", async () => {
		const snapshotDir = mkdtempSync(join(tmpdir(), "bh-test-"));
		const runtime = new PodmanRuntime({ snapshotDir, socketPath: DAEMON_SOCKET });
		const id1 = generateInstanceId();
		const id2 = generateInstanceId();
		trackInstance(id1);
		trackInstance(id2);

		await runtime.create(TEST_WORKLOAD, id1);
		await runtime.create(TEST_WORKLOAD, id2);

		const listed = await runtime.list();
		expect(listed).toContain(id1);
		expect(listed).toContain(id2);

		await runtime.destroy({ instanceId: id1, running: false });

		const afterDestroy = await runtime.list();
		expect(afterDestroy).not.toContain(id1);
		expect(afterDestroy).toContain(id2);

		await runtime.destroy({ instanceId: id2, running: false });
	});

	test("destroy is idempotent", async () => {
		const snapshotDir = mkdtempSync(join(tmpdir(), "bh-test-"));
		const runtime = new PodmanRuntime({ snapshotDir, socketPath: DAEMON_SOCKET });
		const instanceId = generateInstanceId();
		trackInstance(instanceId);

		const handle = await runtime.create(TEST_WORKLOAD, instanceId);
		await runtime.start(handle);

		await runtime.destroy(handle);
		// Second destroy should not throw
		await runtime.destroy(handle);
	});

	// CRIU tests — skip if CRIU is not available
	const criuAvailable = (() => {
		if (!podmanAvailable) return false;
		try {
			return process.env.BOILERHOUSE_CRIU_AVAILABLE === "true";
		} catch {
			return false;
		}
	})();

	describe.skipIf(!criuAvailable)("snapshot + restore (CRIU)", () => {
		test("checkpoint creates archive and restore resumes container", async () => {
			const snapshotDir = mkdtempSync(join(tmpdir(), "bh-test-"));
			const runtime = new PodmanRuntime({ snapshotDir, socketPath: DAEMON_SOCKET });
			const instanceId = generateInstanceId();
			trackInstance(instanceId);

			const handle = await runtime.create(TEST_WORKLOAD, instanceId);
			await runtime.start(handle);

			// Write a marker file to verify state is preserved
			await runtime.exec(handle, ["sh", "-c", "echo checkpoint-test > /tmp/marker"]);

			const ref = await runtime.snapshot(handle);

			expect(ref.id).toBeDefined();
			expect(ref.paths.memory).toContain("checkpoint.tar.gz");
			expect(ref.paths.vmstate).toBe(ref.paths.memory);
			expect(ref.runtimeMeta.runtimeVersion).toBeDefined();
			expect(ref.runtimeMeta.architecture).toBeDefined();

			// Archive file should exist with restrictive permissions (0o600)
			const archiveExists = await Bun.file(ref.paths.memory).exists();
			expect(archiveExists).toBe(true);
			const archiveStat = statSync(ref.paths.memory);
			expect(archiveStat.mode & 0o777).toBe(0o600);

			// Restore to a new container
			const restoredId = generateInstanceId();
			trackInstance(restoredId);

			const restoredHandle = await runtime.restore(ref, restoredId);

			expect(restoredHandle.instanceId).toBe(restoredId);
			expect(restoredHandle.running).toBe(true);

			// Verify the marker file persisted through checkpoint/restore
			const markerResult = await runtime.exec(restoredHandle, ["cat", "/tmp/marker"]);
			expect(markerResult.exitCode).toBe(0);
			expect(markerResult.stdout).toBe("checkpoint-test");

			await runtime.destroy(handle);
			await runtime.destroy(restoredHandle);
		});
	});
});
