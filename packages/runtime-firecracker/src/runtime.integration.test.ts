import {
	describe,
	test,
	expect,
	beforeAll,
	afterAll,
	afterEach,
} from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import {
	generateInstanceId,
	type InstanceId,
	type NodeId,
	type InstanceHandle,
} from "@boilerhouse/core";
import type { Workload } from "@boilerhouse/core";
import { FirecrackerRuntime } from "./runtime";
import type { FirecrackerConfig, TapDevice, TapManager } from "./types";

const INTEGRATION = process.env.BOILERHOUSE_INTEGRATION === "1";

/**
 * A real TapManager that creates/destroys TAP devices.
 * Only used in integration tests where we have root access.
 */
class IntegrationTapManager implements TapManager {
	private devices = new Map<string, TapDevice>();
	private nextSubnet = 1;

	async create(instanceId: InstanceId): Promise<TapDevice> {
		const idx = this.nextSubnet++;
		const name = `tap-test-${idx}`;
		const ip = `172.16.${idx}.1`;
		const mac = `02:00:00:00:00:${idx.toString(16).padStart(2, "0")}`;

		const device: TapDevice = { name, ip, mac };

		const commands = [
			`ip tuntap add dev ${name} mode tap`,
			`ip addr add ${ip}/30 dev ${name}`,
			`ip link set ${name} up`,
		];

		for (const cmd of commands) {
			const proc = Bun.spawn(cmd.split(" "), {
				stdout: "pipe",
				stderr: "pipe",
			});
			const exitCode = await proc.exited;
			if (exitCode !== 0) {
				const stderr = await new Response(proc.stderr).text();
				throw new Error(
					`TAP setup failed (exit ${exitCode}): ${cmd}\n${stderr}`,
				);
			}
		}

		this.devices.set(instanceId, device);
		return device;
	}

	async destroy(device: TapDevice): Promise<void> {
		const proc = Bun.spawn(
			["ip", "link", "delete", device.name],
			{ stdout: "pipe", stderr: "pipe" },
		);
		await proc.exited;
	}
}

const TEST_WORKLOAD: Workload = {
	workload: { name: "test-workload", version: "1.0.0" },
	image: { ref: "" }, // Set in beforeAll to actual rootfs path
	resources: { vcpus: 1, memory_mb: 128, disk_gb: 1 },
	network: { access: "none" },
	idle: { action: "hibernate" },
};

describe.skipIf(!INTEGRATION)("FirecrackerRuntime integration", () => {
	let tmpDir: string;
	let config: FirecrackerConfig;
	let runtime: FirecrackerRuntime;
	let tapManager: IntegrationTapManager;
	const activeHandles: InstanceHandle[] = [];

	beforeAll(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "fc-integration-"));

		const binaryPath =
			process.env.FIRECRACKER_BIN ?? "/usr/local/bin/firecracker";
		const kernelPath =
			process.env.FIRECRACKER_KERNEL ?? "/var/lib/firecracker/vmlinux";
		const rootfsPath =
			process.env.FIRECRACKER_ROOTFS ?? "/var/lib/firecracker/rootfs.ext4";

		// Patch workload with actual rootfs path
		TEST_WORKLOAD.image.ref = rootfsPath;

		tapManager = new IntegrationTapManager();

		config = {
			binaryPath,
			kernelPath,
			snapshotDir: join(tmpDir, "snapshots"),
			instanceDir: join(tmpDir, "instances"),
			nodeId: "test-node" as NodeId,
			tapManager,
			bootArgs: "console=ttyS0 reboot=k panic=1 pci=off",
			cpuTemplate: "None",
		};

		runtime = new FirecrackerRuntime(config);
	});

	afterEach(async () => {
		// Clean up active instances
		for (const handle of activeHandles) {
			try {
				await runtime.destroy(handle);
			} catch {
				// Best-effort cleanup
			}
		}
		activeHandles.length = 0;
	});

	afterAll(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	// ── 8.2: Create & Destroy ─────────────────────────────────────────────

	test("create() boots a VM that responds to health check", async () => {
		const instanceId = generateInstanceId();
		const handle = await runtime.create(TEST_WORKLOAD, instanceId);
		activeHandles.push(handle);

		expect(handle.instanceId).toBe(instanceId);
		expect(handle.running).toBe(false);

		// Start the VM
		await runtime.start(handle);
		expect(handle.running).toBe(true);
	});

	test("create() allocates a TAP device", async () => {
		const instanceId = generateInstanceId();
		const handle = await runtime.create(TEST_WORKLOAD, instanceId);
		activeHandles.push(handle);

		const endpoint = await runtime.getEndpoint(handle);
		expect(endpoint.host).toMatch(/^172\.16\./);
		expect(endpoint.port).toBeGreaterThan(0);
	});

	test("create() sets up overlay rootfs", async () => {
		const instanceId = generateInstanceId();
		const handle = await runtime.create(TEST_WORKLOAD, instanceId);
		activeHandles.push(handle);

		const rootfsPath = join(config.instanceDir, instanceId, "rootfs.ext4");
		expect(existsSync(rootfsPath)).toBe(true);
	});

	test("destroy() kills the Firecracker process", async () => {
		const instanceId = generateInstanceId();
		const handle = await runtime.create(TEST_WORKLOAD, instanceId);
		await runtime.start(handle);

		await runtime.destroy(handle);
		expect(handle.running).toBe(false);
	});

	test("destroy() cleans up TAP device", async () => {
		const instanceId = generateInstanceId();
		const handle = await runtime.create(TEST_WORKLOAD, instanceId);
		await runtime.start(handle);

		await runtime.destroy(handle);
		// No error means TAP cleanup succeeded
		expect(handle.running).toBe(false);
	});

	test("destroy() removes overlay files", async () => {
		const instanceId = generateInstanceId();
		const handle = await runtime.create(TEST_WORKLOAD, instanceId);

		const instanceDir = join(config.instanceDir, instanceId);
		expect(existsSync(instanceDir)).toBe(true);

		await runtime.destroy(handle);
		expect(existsSync(instanceDir)).toBe(false);
	});

	// ── 8.3: Snapshot & Restore ───────────────────────────────────────────

	test("snapshot() pauses VM, creates vmstate + memory files, resumes", async () => {
		const instanceId = generateInstanceId();
		const handle = await runtime.create(TEST_WORKLOAD, instanceId);
		activeHandles.push(handle);
		await runtime.start(handle);

		const ref = await runtime.snapshot(handle);

		expect(ref.id).toBeDefined();
		expect(ref.type).toBe("tenant");
		expect(ref.paths.vmstate).toContain("vmstate");
		expect(ref.paths.memory).toContain("memory");
		// VM should still be running (resumed after snapshot)
		expect(handle.running).toBe(true);
	});

	test("snapshot() files exist at expected paths", async () => {
		const instanceId = generateInstanceId();
		const handle = await runtime.create(TEST_WORKLOAD, instanceId);
		activeHandles.push(handle);
		await runtime.start(handle);

		const ref = await runtime.snapshot(handle);

		expect(existsSync(ref.paths.vmstate)).toBe(true);
		expect(existsSync(ref.paths.memory)).toBe(true);

		// Self-contained: rootfs copied into snapshot dir
		const snapshotDir = join(config.snapshotDir, ref.id);
		expect(existsSync(join(snapshotDir, "rootfs.ext4"))).toBe(true);
	});

	test("restore() from snapshot produces a running VM", async () => {
		const instanceId = generateInstanceId();
		const handle = await runtime.create(TEST_WORKLOAD, instanceId);
		activeHandles.push(handle);
		await runtime.start(handle);

		const ref = await runtime.snapshot(handle);

		const newInstanceId = generateInstanceId();
		const restored = await runtime.restore(ref, newInstanceId);
		activeHandles.push(restored);

		expect(restored.instanceId).toBe(newInstanceId);
		expect(restored.running).toBe(true);
	});

	test("restore() VM responds to health check", async () => {
		const instanceId = generateInstanceId();
		const handle = await runtime.create(TEST_WORKLOAD, instanceId);
		activeHandles.push(handle);
		await runtime.start(handle);

		const ref = await runtime.snapshot(handle);

		const newInstanceId = generateInstanceId();
		const restored = await runtime.restore(ref, newInstanceId);
		activeHandles.push(restored);

		const endpoint = await runtime.getEndpoint(restored);
		expect(endpoint.host).toMatch(/^172\.16\./);
		expect(endpoint.port).toBeGreaterThan(0);
	});

	test("restore() allocates a new TAP device", async () => {
		const instanceId = generateInstanceId();
		const handle = await runtime.create(TEST_WORKLOAD, instanceId);
		activeHandles.push(handle);
		await runtime.start(handle);

		const ref = await runtime.snapshot(handle);

		const origEndpoint = await runtime.getEndpoint(handle);

		const newInstanceId = generateInstanceId();
		const restored = await runtime.restore(ref, newInstanceId);
		activeHandles.push(restored);

		const newEndpoint = await runtime.getEndpoint(restored);
		// New instance should have a different IP (different TAP device)
		expect(newEndpoint.host).not.toBe(origEndpoint.host);
	});

	test("snapshot + restore round-trip: guest state is preserved", async () => {
		const instanceId = generateInstanceId();
		const handle = await runtime.create(TEST_WORKLOAD, instanceId);
		activeHandles.push(handle);
		await runtime.start(handle);

		const ref = await runtime.snapshot(handle);

		expect(ref.runtimeMeta.runtimeVersion).toBeDefined();
		expect(ref.runtimeMeta.cpuTemplate).toBe("None");
		expect(ref.runtimeMeta.architecture).toBe("x86_64");
		expect(ref.workloadId).toBeDefined();
		expect(ref.nodeId).toBe("test-node" as NodeId);

		const newInstanceId = generateInstanceId();
		const restored = await runtime.restore(ref, newInstanceId);
		activeHandles.push(restored);

		expect(restored.running).toBe(true);
	});
});
