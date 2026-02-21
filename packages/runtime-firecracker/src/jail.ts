import { join } from "node:path";
import { mkdirSync, linkSync, copyFileSync } from "node:fs";
import type { InstanceId } from "@boilerhouse/core";
import type { JailPaths } from "./types";
import { JailError } from "./errors";

export interface JailPrepareOptions {
	instanceId: InstanceId;
	chrootBaseDir: string;
	kernelPath: string;
	rootfsPath: string;
	uid: number;
	gid: number;
}

export interface JailRestoreOptions extends JailPrepareOptions {
	vmstatePath: string;
	memoryPath: string;
}

/**
 * Hard-links a file into the target directory. Falls back to
 * `cp --reflink=auto` if the hard link fails (e.g. cross-device).
 */
function linkOrCopy(src: string, dst: string): void {
	try {
		linkSync(src, dst);
	} catch {
		copyFileSync(src, dst);
	}
}

/**
 * Prepares chroot jail directories for Firecracker jailer.
 *
 * The jailer expects a specific directory layout:
 * ```
 * {chrootBaseDir}/firecracker/{instanceId}/root/
 *   vmlinux        (kernel)
 *   rootfs.ext4    (rootfs)
 *   run/firecracker.socket  (API socket, created by FC)
 * ```
 */
export class JailPreparer {
	/**
	 * Prepares a chroot directory with kernel and rootfs for a fresh VM.
	 */
	async prepare(opts: JailPrepareOptions): Promise<JailPaths> {
		const { instanceId, chrootBaseDir, kernelPath, rootfsPath, uid, gid } = opts;

		const jailBase = join(chrootBaseDir, "firecracker", instanceId);
		const chrootRoot = join(jailBase, "root");
		const logPath = join(jailBase, `${instanceId}.log`);

		try {
			mkdirSync(chrootRoot, { recursive: true });
		} catch (err) {
			throw new JailError(
				`Failed to create chroot directory ${chrootRoot}: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		// Place kernel and rootfs into chroot root via hard-link (or copy fallback)
		const kernelDst = join(chrootRoot, "vmlinux");
		const rootfsDst = join(chrootRoot, "rootfs.ext4");

		try {
			linkOrCopy(kernelPath, kernelDst);
			linkOrCopy(rootfsPath, rootfsDst);
		} catch (err) {
			throw new JailError(
				`Failed to place files in chroot: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		// chown requires root — skip in non-root environments
		await this.chownBestEffort(chrootRoot, uid, gid);

		// API socket path: the jailer creates it at {chrootRoot}/run/firecracker.socket
		const apiSocket = join(chrootRoot, "run", "firecracker.socket");

		return {
			chrootRoot,
			apiSocket,
			kernelRelative: "vmlinux",
			rootfsRelative: "rootfs.ext4",
			logPath,
		};
	}

	/**
	 * Prepares a chroot directory for snapshot restore.
	 * Same as prepare(), but also copies vmstate and memory into the chroot.
	 */
	async prepareForRestore(opts: JailRestoreOptions): Promise<JailPaths> {
		const paths = await this.prepare(opts);

		try {
			linkOrCopy(opts.vmstatePath, join(paths.chrootRoot, "vmstate"));
			linkOrCopy(opts.memoryPath, join(paths.chrootRoot, "memory"));
		} catch (err) {
			throw new JailError(
				`Failed to place snapshot files in chroot: ${err instanceof Error ? err.message : String(err)}`,
			);
		}

		// Re-chown after adding snapshot files
		await this.chownBestEffort(paths.chrootRoot, opts.uid, opts.gid);

		return paths;
	}

	/**
	 * Removes the entire jail directory for an instance.
	 */
	async cleanup(instanceId: string, chrootBaseDir: string): Promise<void> {
		const jailDir = join(chrootBaseDir, "firecracker", instanceId);

		const proc = Bun.spawn(["rm", "-rf", jailDir], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;

		if (exitCode !== 0) {
			const stderr = await new Response(proc.stderr).text();
			throw new JailError(
				`Failed to clean up jail directory ${jailDir}: ${stderr.trim()}`,
			);
		}
	}

	/** Best-effort chown -R. Silently ignored if not running as root. */
	private async chownBestEffort(
		path: string,
		uid: number,
		gid: number,
	): Promise<void> {
		if (process.getuid?.() !== 0) return;

		const proc = Bun.spawn(
			["chown", "-R", `${uid}:${gid}`, path],
			{ stdout: "pipe", stderr: "pipe" },
		);
		await proc.exited;
		// Silently ignore failures — chown may fail in containerized environments
	}
}
