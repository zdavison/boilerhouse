import { join } from "node:path";
import { existsSync } from "node:fs";
import { mkdirSync } from "node:fs";
import {
	generateSnapshotId,
	type InstanceId,
	type WorkloadId,
} from "@boilerhouse/core";
import type {
	Runtime,
	InstanceHandle,
	Endpoint,
	ExecResult,
} from "@boilerhouse/core";
import type { SnapshotRef } from "@boilerhouse/core";
import type { Workload } from "@boilerhouse/core";
import { FirecrackerClient } from "./client";
import {
	FirecrackerError,
	InstanceNotFoundError,
	SnapshotError,
} from "./errors";
import type { FirecrackerProcess } from "./process";
import { spawnFirecracker } from "./process";
import { createOverlay, removeOverlay } from "./overlay";
import type { OverlayPaths } from "./overlay";
import type { FirecrackerConfig, TapDevice } from "./types";

interface ManagedInstance {
	instanceId: InstanceId;
	process: FirecrackerProcess;
	client: FirecrackerClient;
	tapDevice: TapDevice;
	overlayPaths: OverlayPaths;
	workloadId: WorkloadId;
	running: boolean;
}

const DEFAULT_BOOT_ARGS = "console=ttyS0 reboot=k panic=1 pci=off";

export class FirecrackerRuntime implements Runtime {
	private readonly instances = new Map<string, ManagedInstance>();
	private readonly config: FirecrackerConfig;

	constructor(config: FirecrackerConfig) {
		this.config = config;
	}

	async create(
		workload: Workload,
		instanceId: InstanceId,
	): Promise<InstanceHandle> {
		const instanceDir = join(this.config.instanceDir, instanceId);
		mkdirSync(instanceDir, { recursive: true });

		// Resolve rootfs path from workload image
		const rootfsPath = this.resolveRootfsPath(workload);

		// Create copy-on-write overlay
		const overlayPaths = await createOverlay({
			baseRootfsPath: rootfsPath,
			instanceDir,
		});

		// Create TAP device
		const tapDevice = await this.config.tapManager.create(instanceId);

		// Spawn Firecracker process
		const socketPath = join(instanceDir, "firecracker.sock");
		const logPath = join(instanceDir, "firecracker.log");
		const process = spawnFirecracker({
			binaryPath: this.config.binaryPath,
			socketPath,
			logPath,
		});

		await process.waitForSocket();

		// Configure VM via API
		const client = new FirecrackerClient(socketPath);

		await client.putBootSource({
			kernel_image_path: this.config.kernelPath,
			boot_args: this.config.bootArgs ?? DEFAULT_BOOT_ARGS,
		});

		await client.putMachineConfig({
			vcpu_count: workload.resources.vcpus,
			mem_size_mib: workload.resources.memory_mb,
			smt: false,
			cpu_template: this.config.cpuTemplate ?? "None",
			track_dirty_pages: true,
		});

		await client.putDrive("rootfs", {
			drive_id: "rootfs",
			path_on_host: overlayPaths.rootfs,
			is_root_device: true,
			is_read_only: false,
		});

		await client.putNetworkInterface("eth0", {
			iface_id: "eth0",
			host_dev_name: tapDevice.name,
			guest_mac: tapDevice.mac,
		});

		// Derive workloadId from workload name+version
		const workloadId =
			`${workload.workload.name}:${workload.workload.version}` as WorkloadId;

		const managed: ManagedInstance = {
			instanceId,
			process,
			client,
			tapDevice,
			overlayPaths,
			workloadId,
			running: false,
		};
		this.instances.set(instanceId, managed);

		return { instanceId, running: false };
	}

	async start(handle: InstanceHandle): Promise<void> {
		const managed = this.requireInstance(handle.instanceId);
		await managed.client.putAction({ action_type: "InstanceStart" });
		managed.running = true;
		handle.running = true;
	}

	async stop(handle: InstanceHandle): Promise<void> {
		const managed = this.requireInstance(handle.instanceId);
		await managed.client.putAction({ action_type: "SendCtrlAltDel" });

		// Wait for process exit with timeout
		const timeout = setTimeout(() => {
			managed.process.kill();
		}, 5000);

		try {
			await managed.process.proc.exited;
		} finally {
			clearTimeout(timeout);
		}

		managed.running = false;
		handle.running = false;
	}

	async destroy(handle: InstanceHandle): Promise<void> {
		const managed = this.requireInstance(handle.instanceId);

		// Best-effort cleanup — continue on individual step failures
		const errors: Error[] = [];

		try {
			managed.process.kill();
			await managed.process.proc.exited;
		} catch (err) {
			errors.push(
				err instanceof Error ? err : new Error(String(err)),
			);
		}

		try {
			await this.config.tapManager.destroy(managed.tapDevice);
		} catch (err) {
			errors.push(
				err instanceof Error ? err : new Error(String(err)),
			);
		}

		try {
			await removeOverlay(managed.overlayPaths.instanceDir);
		} catch (err) {
			errors.push(
				err instanceof Error ? err : new Error(String(err)),
			);
		}

		managed.running = false;
		handle.running = false;
		this.instances.delete(handle.instanceId);

		if (errors.length > 0) {
			throw new FirecrackerError(
				`Destroy completed with ${errors.length} error(s): ${errors.map((e) => e.message).join("; ")}`,
			);
		}
	}

	async snapshot(handle: InstanceHandle): Promise<SnapshotRef> {
		const managed = this.requireInstance(handle.instanceId);
		const snapshotId = generateSnapshotId();
		const snapshotDir = join(this.config.snapshotDir, snapshotId);

		mkdirSync(snapshotDir, { recursive: true });

		const snapshotPath = join(snapshotDir, "vmstate");
		const memFilePath = join(snapshotDir, "memory");

		// Pause VM
		await managed.client.patchVm({ state: "Paused" });

		try {
			// Create snapshot
			await managed.client.putSnapshotCreate({
				snapshot_type: "Full",
				snapshot_path: snapshotPath,
				mem_file_path: memFilePath,
			});

			// Copy rootfs into snapshot dir for self-contained snapshots
			const snapshotRootfs = join(snapshotDir, "rootfs.ext4");
			const cpProc = Bun.spawn(
				[
					"cp",
					"--reflink=auto",
					managed.overlayPaths.rootfs,
					snapshotRootfs,
				],
				{ stdout: "pipe", stderr: "pipe" },
			);
			const exitCode = await cpProc.exited;
			if (exitCode !== 0) {
				const stderr = await new Response(cpProc.stderr).text();
				throw new SnapshotError(
					`Failed to copy rootfs into snapshot: ${stderr.trim()}`,
				);
			}
		} finally {
			// Always resume VM after snapshot
			await managed.client.patchVm({ state: "Resumed" });
		}

		// Get runtime info for metadata
		const info = await managed.client.getInstanceInfo();

		return {
			id: snapshotId,
			type: "tenant",
			paths: {
				memory: memFilePath,
				vmstate: snapshotPath,
			},
			workloadId: managed.workloadId,
			nodeId: this.config.nodeId,
			runtimeMeta: {
				runtimeVersion: info.vmm_version,
				cpuTemplate: this.config.cpuTemplate ?? "None",
				architecture: "x86_64",
			},
		};
	}

	async restore(
		ref: SnapshotRef,
		instanceId: InstanceId,
	): Promise<InstanceHandle> {
		const instanceDir = join(this.config.instanceDir, instanceId);
		mkdirSync(instanceDir, { recursive: true });

		// Copy rootfs from snapshot dir to new instance dir
		const snapshotDir = join(
			this.config.snapshotDir,
			ref.id,
		);
		const snapshotRootfs = join(snapshotDir, "rootfs.ext4");
		const instanceRootfs = join(instanceDir, "rootfs.ext4");

		const cpProc = Bun.spawn(
			["cp", "--reflink=auto", snapshotRootfs, instanceRootfs],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const cpExit = await cpProc.exited;
		if (cpExit !== 0) {
			const stderr = await new Response(cpProc.stderr).text();
			throw new SnapshotError(
				`Failed to copy rootfs from snapshot: ${stderr.trim()}`,
			);
		}

		// Create new TAP device
		const tapDevice = await this.config.tapManager.create(instanceId);

		// Spawn new Firecracker process
		const socketPath = join(instanceDir, "firecracker.sock");
		const logPath = join(instanceDir, "firecracker.log");
		const process = spawnFirecracker({
			binaryPath: this.config.binaryPath,
			socketPath,
			logPath,
		});

		await process.waitForSocket();

		const client = new FirecrackerClient(socketPath);

		// Configure drives and network (required before snapshot load)
		await client.putDrive("rootfs", {
			drive_id: "rootfs",
			path_on_host: instanceRootfs,
			is_root_device: true,
			is_read_only: false,
		});

		await client.putNetworkInterface("eth0", {
			iface_id: "eth0",
			host_dev_name: tapDevice.name,
			guest_mac: tapDevice.mac,
		});

		// Load snapshot and resume
		await client.putSnapshotLoad({
			snapshot_path: ref.paths.vmstate,
			mem_file_path: ref.paths.memory,
			resume_vm: true,
		});

		const managed: ManagedInstance = {
			instanceId,
			process,
			client,
			tapDevice,
			overlayPaths: { rootfs: instanceRootfs, instanceDir },
			workloadId: ref.workloadId,
			running: true,
		};
		this.instances.set(instanceId, managed);

		return { instanceId, running: true };
	}

	async exec(
		_handle: InstanceHandle,
		_command: string[],
	): Promise<ExecResult> {
		throw new FirecrackerError(
			"exec requires a guest agent — not yet implemented",
		);
	}

	async getEndpoint(handle: InstanceHandle): Promise<Endpoint> {
		const managed = this.requireInstance(handle.instanceId);

		// Derive guest IP from TAP device IP (host is .1, guest is .2 in /30 subnet)
		const hostIp = managed.tapDevice.ip;
		const parts = hostIp.split(".");
		const lastOctet = Number.parseInt(parts[3]!, 10);
		const guestIp = `${parts[0]}.${parts[1]}.${parts[2]}.${lastOctet + 1}`;

		// Use the first exposed port from the workload, or default to 8080
		const port = 8080;

		return { host: guestIp, port };
	}

	async available(): Promise<boolean> {
		const hasBinary = existsSync(this.config.binaryPath);
		const hasKvm = existsSync("/dev/kvm");
		return hasBinary && hasKvm;
	}

	private requireInstance(instanceId: InstanceId): ManagedInstance {
		const managed = this.instances.get(instanceId);
		if (!managed) {
			throw new InstanceNotFoundError(instanceId);
		}
		return managed;
	}

	private resolveRootfsPath(workload: Workload): string {
		// The rootfs path is derived from the image reference.
		// In production, the build pipeline produces rootfs images at a known location.
		// For now, use the image ref directly as the path.
		if (workload.image.ref) {
			return workload.image.ref;
		}
		throw new FirecrackerError(
			"Workload must have an image.ref pointing to the rootfs path",
		);
	}
}
