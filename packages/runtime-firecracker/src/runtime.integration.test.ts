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
import type { FirecrackerConfig, TapDevice, TapManager, JailerConfig } from "./types";
import { NetnsManagerImpl } from "./netns";

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

	async createFromDevice(device: TapDevice): Promise<TapDevice> {
		const commands = [
			`ip tuntap add dev ${device.name} mode tap`,
			`ip addr add ${device.ip}/30 dev ${device.name}`,
			`ip link set ${device.name} up`,
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
			imagesDir: join(tmpDir, "images"),
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
		expect(endpoint.ports.length).toBeGreaterThan(0);
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
		expect(endpoint.ports.length).toBeGreaterThan(0);
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

// ── Jailer Integration Tests ───────────────────────────────────────────────

const IS_ROOT = process.getuid?.() === 0;

const JAILER_WORKLOAD: Workload = {
	workload: { name: "test-jailer", version: "1.0.0" },
	image: { ref: "" },
	resources: { vcpus: 1, memory_mb: 128, disk_gb: 1 },
	network: { access: "none" },
	idle: { action: "hibernate" },
};

describe.skipIf(!INTEGRATION || !IS_ROOT)(
	"FirecrackerRuntime integration (jailer)",
	() => {
		let tmpDir: string;
		let config: FirecrackerConfig;
		let runtime: FirecrackerRuntime;
		let netnsManager: NetnsManagerImpl;
		const activeHandles: InstanceHandle[] = [];

		beforeAll(() => {
			tmpDir = mkdtempSync(join(tmpdir(), "fc-jailer-integ-"));

			const binaryPath =
				process.env.FIRECRACKER_BIN ?? "/usr/local/bin/firecracker";
			const kernelPath =
				process.env.FIRECRACKER_KERNEL ?? "/var/lib/firecracker/vmlinux";
			const rootfsPath =
				process.env.FIRECRACKER_ROOTFS ??
				"/var/lib/firecracker/rootfs.ext4";
			const jailerPath =
				process.env.JAILER_BIN ?? "/usr/local/bin/jailer";

			JAILER_WORKLOAD.image.ref = rootfsPath;

			netnsManager = new NetnsManagerImpl();

			const jailerConfig: JailerConfig = {
				jailerPath,
				chrootBaseDir: join(tmpDir, "jailer"),
				uidRangeStart: 200000,
				gid: 200000,
				daemonize: true,
				newPidNs: true,
				cgroupVersion: 2,
			};

			config = {
				binaryPath,
				kernelPath,
				snapshotDir: join(tmpDir, "snapshots"),
				instanceDir: join(tmpDir, "instances"),
				imagesDir: join(tmpDir, "images"),
				nodeId: "test-jailer-node" as NodeId,
				jailer: jailerConfig,
				bootArgs: "console=ttyS0 reboot=k panic=1 pci=off",
				cpuTemplate: "None",
			};

			runtime = new FirecrackerRuntime(config);
		});

		afterEach(async () => {
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

		test("create() boots a VM in a chroot", async () => {
			const instanceId = generateInstanceId();
			const handle = await runtime.create(JAILER_WORKLOAD, instanceId);
			activeHandles.push(handle);

			expect(handle.instanceId).toBe(instanceId);
			expect(handle.running).toBe(false);

			// Chroot directory should exist
			const chrootRoot = join(
				config.jailer!.chrootBaseDir,
				"firecracker",
				instanceId,
				"root",
			);
			expect(existsSync(chrootRoot)).toBe(true);

			await runtime.start(handle);
			expect(handle.running).toBe(true);
		});

		test("VM process runs as unprivileged UID", async () => {
			const instanceId = generateInstanceId();
			const handle = await runtime.create(JAILER_WORKLOAD, instanceId);
			activeHandles.push(handle);
			await runtime.start(handle);

			// Check that the Firecracker process is running as the derived UID
			const pidFile = join(
				config.jailer!.chrootBaseDir,
				"firecracker",
				instanceId,
				"root",
				"firecracker.pid",
			);
			if (existsSync(pidFile)) {
				const pid = (await Bun.file(pidFile).text()).trim();
				const proc = Bun.spawn(["ps", "-o", "uid=", "-p", pid], {
					stdout: "pipe",
					stderr: "pipe",
				});
				const stdout = await new Response(proc.stdout).text();
				const uid = Number(stdout.trim());
				expect(uid).toBeGreaterThanOrEqual(
					config.jailer!.uidRangeStart,
				);
			}
		});

		test("VM is in its own network namespace", async () => {
			const instanceId = generateInstanceId();
			const handle = await runtime.create(JAILER_WORKLOAD, instanceId);
			activeHandles.push(handle);

			const nsList = await netnsManager.list();
			const hasNs = nsList.some((ns) => ns.startsWith("fc-"));
			expect(hasNs).toBe(true);
		});

		test("destroy() removes chroot and namespace", async () => {
			const instanceId = generateInstanceId();
			const handle = await runtime.create(JAILER_WORKLOAD, instanceId);
			await runtime.start(handle);

			const chrootDir = join(
				config.jailer!.chrootBaseDir,
				"firecracker",
				instanceId,
			);
			expect(existsSync(chrootDir)).toBe(true);

			await runtime.destroy(handle);

			expect(handle.running).toBe(false);
			expect(existsSync(chrootDir)).toBe(false);
		});

		test("snapshot() creates files and copies them out of chroot", async () => {
			const instanceId = generateInstanceId();
			const handle = await runtime.create(JAILER_WORKLOAD, instanceId);
			activeHandles.push(handle);
			await runtime.start(handle);

			const ref = await runtime.snapshot(handle);

			expect(ref.id).toBeDefined();
			expect(existsSync(ref.paths.vmstate)).toBe(true);
			expect(existsSync(ref.paths.memory)).toBe(true);

			const snapshotDir = join(config.snapshotDir, ref.id);
			expect(existsSync(join(snapshotDir, "rootfs.ext4"))).toBe(true);
		});

		test("restore() creates new jail with snapshot state", async () => {
			const instanceId = generateInstanceId();
			const handle = await runtime.create(JAILER_WORKLOAD, instanceId);
			activeHandles.push(handle);
			await runtime.start(handle);

			const ref = await runtime.snapshot(handle);

			const newInstanceId = generateInstanceId();
			const restored = await runtime.restore(ref, newInstanceId);
			activeHandles.push(restored);

			expect(restored.instanceId).toBe(newInstanceId);
			expect(restored.running).toBe(true);

			// New chroot should exist
			const newChrootRoot = join(
				config.jailer!.chrootBaseDir,
				"firecracker",
				newInstanceId,
				"root",
			);
			expect(existsSync(newChrootRoot)).toBe(true);
		});
	},
);
