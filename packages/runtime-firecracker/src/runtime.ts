import { join, dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, symlinkSync, unlinkSync, rmdirSync } from "node:fs";
import {
	generateSnapshotId,
	resolveImagePath,
	type InstanceId,
	type SnapshotId,
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
import { spawnFirecracker, spawnJailer, resolveExecFile } from "./process";
import type { JailedProcess } from "./process";
import { createOverlay, removeOverlay } from "./overlay";
import type { OverlayPaths } from "./overlay";
import type { FirecrackerConfig, TapDevice, NetnsHandle, JailPaths } from "./types";
import { NetnsManagerImpl } from "./netns";
import { JailPreparer } from "./jail";

interface ManagedInstance {
	instanceId: InstanceId;
	process: FirecrackerProcess | JailedProcess;
	client: FirecrackerClient;
	overlayPaths: OverlayPaths;
	workloadId: WorkloadId;
	running: boolean;
	/** Guest ports exposed by the workload (from `network.expose[*].guest`). */
	exposedPorts: number[];
	// Dev mode
	tapDevice?: TapDevice;
	// Jailer mode
	netnsHandle?: NetnsHandle;
	jailPaths?: JailPaths;
	uid?: number;
}

const DEFAULT_BOOT_ARGS = "console=ttyS0 reboot=k panic=1 pci=off";

/**
 * Builds kernel boot args with an `ip=` parameter for automatic guest
 * network configuration. The kernel configures eth0 before init runs,
 * so this works with any rootfs (no userspace setup needed).
 *
 * Format: ip=<client-ip>:<server-ip>:<gw-ip>:<netmask>:<hostname>:<device>:<autoconf>
 */
function buildBootArgs(baseArgs: string, guestIp: string, gatewayIp: string): string {
	return `${baseArgs} ip=${guestIp}::${gatewayIp}:255.255.255.252::eth0:off`;
}

/**
 * Splits the workload entrypoint into kernel-side and init-side boot args.
 * The kernel `--` separator must come AFTER all kernel params (like `ip=`),
 * because the kernel passes everything after `--` as argv to init.
 */
function buildEntrypointBootArgs(workload: Workload): { kernelArgs: string; initArgs: string } {
	if (!workload.entrypoint) return { kernelArgs: "", initArgs: "" };
	const parts = [workload.entrypoint.cmd, ...(workload.entrypoint.args ?? [])];
	return {
		kernelArgs: " init=/opt/boilerhouse/init",
		initArgs: ` -- ${parts.join(" ")}`,
	};
}

/** Derives the guest IP (.2) from a TAP host IP (.1) in a /30 subnet. */
function deriveGuestIp(hostIp: string): string {
	const parts = hostIp.split(".");
	const lastOctet = Number.parseInt(parts[3]!, 10);
	return `${parts[0]}.${parts[1]}.${parts[2]}.${lastOctet + 1}`;
}

export class FirecrackerRuntime implements Runtime {
	private readonly instances = new Map<string, ManagedInstance>();
	private readonly config: FirecrackerConfig;
	private readonly isJailerMode: boolean;
	private readonly netnsManager?: NetnsManagerImpl;
	private readonly jailPreparer?: JailPreparer;

	constructor(config: FirecrackerConfig) {
		if (!config.tapManager && !config.jailer) {
			throw new FirecrackerError(
				"FirecrackerConfig requires either tapManager (dev mode) or jailer (production mode)",
			);
		}
		this.config = config;
		this.isJailerMode = !!config.jailer;

		if (this.isJailerMode) {
			this.netnsManager = new NetnsManagerImpl();
			this.jailPreparer = new JailPreparer();
		}
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

		// Derive workloadId from workload name+version
		const workloadId =
			`${workload.workload.name}:${workload.workload.version}` as WorkloadId;

		if (this.isJailerMode) {
			return this.createJailed(workload, instanceId, overlayPaths, workloadId);
		}
		return this.createDirect(workload, instanceId, overlayPaths, workloadId);
	}

	async start(handle: InstanceHandle): Promise<void> {
		const managed = this.requireInstance(handle.instanceId);
		await managed.client.putAction({ action_type: "InstanceStart" });
		managed.running = true;
		handle.running = true;
	}

	async destroy(handle: InstanceHandle): Promise<void> {
		const managed = this.requireInstance(handle.instanceId);
		const errors: Error[] = [];

		if (this.isJailerMode) {
			// Kill jailed process
			try {
				await (managed.process as JailedProcess).kill();
			} catch (err) {
				errors.push(err instanceof Error ? err : new Error(String(err)));
			}

			// Destroy network namespace
			if (managed.netnsHandle) {
				try {
					await this.netnsManager!.destroy(managed.netnsHandle);
				} catch (err) {
					errors.push(err instanceof Error ? err : new Error(String(err)));
				}
			}

			// Clean up jail
			if (managed.jailPaths) {
				try {
					await this.jailPreparer!.cleanup(
						managed.instanceId,
						this.config.jailer!.chrootBaseDir,
					);
				} catch (err) {
					errors.push(err instanceof Error ? err : new Error(String(err)));
				}
			}
		} else {
			// Kill direct process
			try {
				(managed.process as FirecrackerProcess).kill();
				await (managed.process as FirecrackerProcess).proc.exited;
			} catch (err) {
				errors.push(err instanceof Error ? err : new Error(String(err)));
			}

			// Destroy TAP device
			if (managed.tapDevice) {
				try {
					await this.config.tapManager!.destroy(managed.tapDevice);
				} catch (err) {
					errors.push(err instanceof Error ? err : new Error(String(err)));
				}
			}
		}

		// Remove overlay (common to both modes)
		try {
			await removeOverlay(managed.overlayPaths.instanceDir);
		} catch (err) {
			errors.push(err instanceof Error ? err : new Error(String(err)));
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

		if (this.isJailerMode) {
			return this.snapshotJailed(managed, snapshotId, snapshotDir);
		}
		return this.snapshotDirect(managed, snapshotId, snapshotDir);
	}

	async restore(
		ref: SnapshotRef,
		instanceId: InstanceId,
	): Promise<InstanceHandle> {
		const instanceDir = join(this.config.instanceDir, instanceId);
		mkdirSync(instanceDir, { recursive: true });

		// Copy rootfs from snapshot dir to new instance dir
		const snapshotDir = join(this.config.snapshotDir, ref.id);
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

		if (this.isJailerMode) {
			return this.restoreJailed(ref, instanceId, instanceDir, instanceRootfs);
		}
		return this.restoreDirect(ref, instanceId, instanceDir, instanceRootfs);
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

		if (managed.exposedPorts.length === 0) {
			throw new FirecrackerError(
				`Instance ${handle.instanceId} has no exposed ports — workload must define network.expose`,
			);
		}

		if (this.isJailerMode && managed.netnsHandle) {
			return { host: managed.netnsHandle.guestIp, ports: managed.exposedPorts };
		}

		// Dev mode: derive guest IP from TAP device IP (host is .1, guest is .2 in /30 subnet)
		const guestIp = deriveGuestIp(managed.tapDevice!.ip);

		return { host: guestIp, ports: managed.exposedPorts };
	}

	async list(): Promise<InstanceId[]> {
		return Array.from(this.instances.keys()) as InstanceId[];
	}

	async available(): Promise<boolean> {
		const hasBinary = existsSync(this.config.binaryPath);
		const hasKvm = existsSync("/dev/kvm");

		if (this.isJailerMode) {
			const hasJailer = existsSync(this.config.jailer!.jailerPath);
			return hasBinary && hasKvm && hasJailer;
		}

		return hasBinary && hasKvm;
	}

	// ── Private: Direct mode (dev) ───────────────────────────────────────────

	private async createDirect(
		workload: Workload,
		instanceId: InstanceId,
		overlayPaths: OverlayPaths,
		workloadId: WorkloadId,
	): Promise<InstanceHandle> {
		const tapDevice = await this.config.tapManager!.create(instanceId);

		const socketPath = join(overlayPaths.instanceDir, "firecracker.sock");
		const logPath = join(overlayPaths.instanceDir, "firecracker.log");
		const process = spawnFirecracker({
			binaryPath: this.config.binaryPath,
			socketPath,
			logPath,
		});

		await process.waitForSocket();

		const client = new FirecrackerClient(socketPath);

		const guestIp = deriveGuestIp(tapDevice.ip);
		const entrypoint = buildEntrypointBootArgs(workload);
		const baseArgs = (this.config.bootArgs ?? DEFAULT_BOOT_ARGS) + entrypoint.kernelArgs;
		const bootArgs = buildBootArgs(baseArgs, guestIp, tapDevice.ip) + entrypoint.initArgs;

		await client.putBootSource({
			kernel_image_path: this.config.kernelPath,
			boot_args: bootArgs,
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

		const managed: ManagedInstance = {
			instanceId,
			process,
			client,
			tapDevice,
			overlayPaths,
			workloadId,
			running: false,
			exposedPorts: (workload.network.expose ?? []).map((e) => e.guest),
		};
		this.instances.set(instanceId, managed);

		return { instanceId, running: false };
	}

	private async snapshotDirect(
		managed: ManagedInstance,
		snapshotId: SnapshotId,
		snapshotDir: string,
	): Promise<SnapshotRef> {
		const snapshotPath = join(snapshotDir, "vmstate");
		const memFilePath = join(snapshotDir, "memory");

		await managed.client.patchVm({ state: "Paused" });

		try {
			await managed.client.putSnapshotCreate({
				snapshot_type: "Full",
				snapshot_path: snapshotPath,
				mem_file_path: memFilePath,
			});

			const snapshotRootfs = join(snapshotDir, "rootfs.ext4");
			const cpProc = Bun.spawn(
				["cp", "--reflink=auto", managed.overlayPaths.rootfs, snapshotRootfs],
				{ stdout: "pipe", stderr: "pipe" },
			);
			const exitCode = await cpProc.exited;
			if (exitCode !== 0) {
				const stderr = await new Response(cpProc.stderr).text();
				throw new SnapshotError(
					`Failed to copy rootfs into snapshot: ${stderr.trim()}`,
				);
			}

			// Save the original device paths and TAP config so restore can
			// recreate the exact environment the snapshot was taken in.
			// Firecracker requires drive files at the paths stored in the
			// vmstate, and the TAP device with the same name.
			await Bun.write(
				join(snapshotDir, "restore-meta.json"),
				JSON.stringify({
					rootfs: resolve(managed.overlayPaths.rootfs),
					tapDevice: managed.tapDevice,
				}),
			);
		} finally {
			await managed.client.patchVm({ state: "Resumed" });
		}

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
				exposedPorts: managed.exposedPorts,
			},
		};
	}

	private async restoreDirect(
		ref: SnapshotRef,
		instanceId: InstanceId,
		instanceDir: string,
		instanceRootfs: string,
	): Promise<InstanceHandle> {
		// Read the original device paths and TAP config from the snapshot
		const snapshotDir = join(this.config.snapshotDir, ref.id);
		const restoreMeta = await this.readRestoreMeta(snapshotDir);

		// Recreate the exact TAP device that existed when the snapshot was
		// taken. Firecracker opens the TAP during snapshot load and its
		// PATCH API doesn't support changing host_dev_name after load.
		const tapDevice = await this.config.tapManager!.createFromDevice(
			restoreMeta.tapDevice!,
		);

		const socketPath = join(instanceDir, "firecracker.sock");
		const logPath = join(instanceDir, "firecracker.log");
		const process = spawnFirecracker({
			binaryPath: this.config.binaryPath,
			socketPath,
			logPath,
		});

		await process.waitForSocket();

		const client = new FirecrackerClient(socketPath);

		// Firecracker requires drive files at the paths stored in the vmstate
		// during snapshot load. Create a temporary symlink from the original
		// path to the new rootfs so the load succeeds.
		const symlinkCreated = this.createRootfsSymlink(
			restoreMeta.rootfs,
			instanceRootfs,
		);

		try {
			await client.putSnapshotLoad({
				snapshot_path: ref.paths.vmstate,
				mem_file_path: ref.paths.memory,
				resume_vm: false,
			});

			// Patch drive to update rootfs to the real new path
			await client.patchDrive("rootfs", {
				drive_id: "rootfs",
				path_on_host: instanceRootfs,
			});

			// Resume the VM
			await client.patchVm({ state: "Resumed" });
		} finally {
			if (symlinkCreated) {
				this.removeRootfsSymlink(restoreMeta.rootfs);
			}
		}

		const managed: ManagedInstance = {
			instanceId,
			process,
			client,
			tapDevice,
			overlayPaths: { rootfs: instanceRootfs, instanceDir },
			workloadId: ref.workloadId,
			running: true,
			exposedPorts: ref.runtimeMeta.exposedPorts ?? [],
		};
		this.instances.set(instanceId, managed);

		return { instanceId, running: true };
	}

	// ── Private: Jailer mode ─────────────────────────────────────────────────

	/** Derive a deterministic UID from the instance ID. */
	private deriveUid(instanceId: InstanceId): number {
		const hash = createHash("sha256").update(instanceId).digest();
		return (hash.readUInt16BE(0) % 65535) + this.config.jailer!.uidRangeStart;
	}

	private async createJailed(
		workload: Workload,
		instanceId: InstanceId,
		overlayPaths: OverlayPaths,
		workloadId: WorkloadId,
	): Promise<InstanceHandle> {
		const jailer = this.config.jailer!;
		const uid = this.deriveUid(instanceId);

		// Create network namespace
		const netnsHandle = await this.netnsManager!.create(instanceId, uid);

		// Prepare jail chroot
		const jailPaths = await this.jailPreparer!.prepare({
			instanceId,
			chrootBaseDir: jailer.chrootBaseDir,
			kernelPath: this.config.kernelPath,
			rootfsPath: overlayPaths.rootfs,
			uid,
			gid: jailer.gid,
		});

		// Resolve binary path for jailer
		const execFile = await resolveExecFile(this.config.binaryPath);

		// Spawn via jailer
		const process = spawnJailer({
			jailerId: instanceId,
			execFile,
			jailerPath: jailer.jailerPath,
			uid,
			gid: jailer.gid,
			chrootBaseDir: jailer.chrootBaseDir,
			netnsPath: netnsHandle.nsPath,
			daemonize: jailer.daemonize,
			newPidNs: jailer.newPidNs,
			cgroupVersion: jailer.cgroupVersion,
		});

		await process.waitForSocket();

		const client = new FirecrackerClient(process.socketPath);

		// Inside the chroot, paths are relative
		const entrypoint = buildEntrypointBootArgs(workload);
		const baseArgs = (this.config.bootArgs ?? DEFAULT_BOOT_ARGS) + entrypoint.kernelArgs;
		const bootArgs = buildBootArgs(baseArgs, netnsHandle.guestIp, netnsHandle.tapIp) + entrypoint.initArgs;

		await client.putBootSource({
			kernel_image_path: jailPaths.kernelRelative,
			boot_args: bootArgs,
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
			path_on_host: jailPaths.rootfsRelative,
			is_root_device: true,
			is_read_only: false,
		});

		await client.putNetworkInterface("eth0", {
			iface_id: "eth0",
			host_dev_name: netnsHandle.tapName,
			guest_mac: netnsHandle.tapMac,
		});

		const managed: ManagedInstance = {
			instanceId,
			process,
			client,
			overlayPaths,
			workloadId,
			running: false,
			exposedPorts: (workload.network.expose ?? []).map((e) => e.guest),
			netnsHandle,
			jailPaths,
			uid,
		};
		this.instances.set(instanceId, managed);

		return { instanceId, running: false };
	}

	private async snapshotJailed(
		managed: ManagedInstance,
		snapshotId: SnapshotId,
		snapshotDir: string,
	): Promise<SnapshotRef> {
		// Inside chroot, snapshot files are relative
		const chrootSnapshotPath = "vmstate";
		const chrootMemPath = "memory";

		await managed.client.patchVm({ state: "Paused" });

		try {
			await managed.client.putSnapshotCreate({
				snapshot_type: "Full",
				snapshot_path: chrootSnapshotPath,
				mem_file_path: chrootMemPath,
			});

			// Copy vmstate + memory OUT of chroot into snapshot dir
			const chrootRoot = managed.jailPaths!.chrootRoot;
			await this.copyFile(join(chrootRoot, "vmstate"), join(snapshotDir, "vmstate"));
			await this.copyFile(join(chrootRoot, "memory"), join(snapshotDir, "memory"));

			// Copy rootfs into snapshot dir
			const snapshotRootfs = join(snapshotDir, "rootfs.ext4");
			await this.copyFile(managed.overlayPaths.rootfs, snapshotRootfs);

			// Save the original device paths for restore.
			// In jailer mode the rootfs path is relative to chroot root.
			await Bun.write(
				join(snapshotDir, "restore-meta.json"),
				JSON.stringify({ rootfs: managed.jailPaths!.rootfsRelative }),
			);
		} finally {
			await managed.client.patchVm({ state: "Resumed" });
		}

		const info = await managed.client.getInstanceInfo();

		return {
			id: snapshotId,
			type: "tenant",
			paths: {
				memory: join(snapshotDir, "memory"),
				vmstate: join(snapshotDir, "vmstate"),
			},
			workloadId: managed.workloadId,
			nodeId: this.config.nodeId,
			runtimeMeta: {
				runtimeVersion: info.vmm_version,
				cpuTemplate: this.config.cpuTemplate ?? "None",
				architecture: "x86_64",
				exposedPorts: managed.exposedPorts,
			},
		};
	}

	private async restoreJailed(
		ref: SnapshotRef,
		instanceId: InstanceId,
		instanceDir: string,
		instanceRootfs: string,
	): Promise<InstanceHandle> {
		const jailer = this.config.jailer!;
		const uid = this.deriveUid(instanceId);

		// Create network namespace
		const netnsHandle = await this.netnsManager!.create(instanceId, uid);

		// Prepare jail with snapshot files
		const jailPaths = await this.jailPreparer!.prepareForRestore({
			instanceId,
			chrootBaseDir: jailer.chrootBaseDir,
			kernelPath: this.config.kernelPath,
			rootfsPath: instanceRootfs,
			uid,
			gid: jailer.gid,
			vmstatePath: ref.paths.vmstate,
			memoryPath: ref.paths.memory,
		});

		// Resolve binary path for jailer
		const execFile = await resolveExecFile(this.config.binaryPath);

		const process = spawnJailer({
			jailerId: instanceId,
			execFile,
			jailerPath: jailer.jailerPath,
			uid,
			gid: jailer.gid,
			chrootBaseDir: jailer.chrootBaseDir,
			netnsPath: netnsHandle.nsPath,
			daemonize: jailer.daemonize,
			newPidNs: jailer.newPidNs,
			cgroupVersion: jailer.cgroupVersion,
		});

		await process.waitForSocket();

		const client = new FirecrackerClient(process.socketPath);

		// Load snapshot first (without resuming) — must happen before any
		// boot-specific resource configuration
		await client.putSnapshotLoad({
			snapshot_path: "vmstate",
			mem_file_path: "memory",
			resume_vm: false,
		});

		// Patch drive to update rootfs path (relative within chroot).
		// Network interface doesn't need patching — the netns TAP device
		// is created with the same name the snapshot was taken with.
		await client.patchDrive("rootfs", {
			drive_id: "rootfs",
			path_on_host: jailPaths.rootfsRelative,
		});

		// Resume the VM
		await client.patchVm({ state: "Resumed" });

		const managed: ManagedInstance = {
			instanceId,
			process,
			client,
			overlayPaths: { rootfs: instanceRootfs, instanceDir },
			workloadId: ref.workloadId,
			running: true,
			exposedPorts: ref.runtimeMeta.exposedPorts ?? [],
			netnsHandle,
			jailPaths,
			uid,
		};
		this.instances.set(instanceId, managed);

		return { instanceId, running: true };
	}

	// ── Private: Shared helpers ──────────────────────────────────────────────

	private requireInstance(instanceId: InstanceId): ManagedInstance {
		const managed = this.instances.get(instanceId);
		if (!managed) {
			throw new InstanceNotFoundError(instanceId);
		}
		return managed;
	}

	private resolveRootfsPath(workload: Workload): string {
		const rootfsPath = resolveImagePath(this.config.imagesDir, workload);

		if (!existsSync(rootfsPath)) {
			const imageSource = workload.image.ref ?? workload.image.dockerfile ?? "unknown";
			throw new FirecrackerError(
				`Rootfs not found for image '${imageSource}' at ${rootfsPath}`,
			);
		}

		return rootfsPath;
	}

	private async copyFile(src: string, dst: string): Promise<void> {
		const proc = Bun.spawn(
			["cp", "--reflink=auto", src, dst],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			const stderr = await new Response(proc.stderr).text();
			throw new SnapshotError(
				`Failed to copy ${src} to ${dst}: ${stderr.trim()}`,
			);
		}
	}

	/**
	 * Reads the restore metadata (original rootfs path and TAP device config)
	 * from the snapshot's restore-meta.json.
	 */
	private async readRestoreMeta(
		snapshotDir: string,
	): Promise<{ rootfs: string; tapDevice?: TapDevice }> {
		const metaFile = join(snapshotDir, "restore-meta.json");
		const json = await Bun.file(metaFile).text();
		return JSON.parse(json) as { rootfs: string; tapDevice?: TapDevice };
	}

	/**
	 * Creates a temporary symlink at the original rootfs path pointing to the
	 * new rootfs. Returns true if a symlink was created, false if the original
	 * path already exists (e.g. same instance dir).
	 */
	private createRootfsSymlink(originalPath: string, targetPath: string): boolean {
		const absOriginal = resolve(originalPath);
		const absTarget = resolve(targetPath);
		if (absOriginal === absTarget || existsSync(absOriginal)) {
			return false;
		}
		mkdirSync(dirname(absOriginal), { recursive: true });
		symlinkSync(absTarget, absOriginal);
		return true;
	}

	/** Removes the temporary symlink and its parent dir if empty. */
	private removeRootfsSymlink(symlinkPath: string): void {
		const absPath = resolve(symlinkPath);
		try {
			unlinkSync(absPath);
		} catch {
			// Already removed or never created
		}
		try {
			rmdirSync(dirname(absPath));
		} catch {
			// Dir not empty or doesn't exist
		}
	}
}
