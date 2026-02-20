import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { OverlayError } from "./errors";

export interface OverlayPaths {
	/** Path to the copy-on-write rootfs for this instance. */
	rootfs: string;
	/** Instance working directory containing the rootfs. */
	instanceDir: string;
}

export interface CreateOverlayOptions {
	/** Path to the base (read-only template) rootfs image. */
	baseRootfsPath: string;
	/** Per-instance working directory where the overlay is stored. */
	instanceDir: string;
}

/**
 * Create a per-instance rootfs overlay by copying the base image.
 * Uses `cp --reflink=auto` for copy-on-write on supported filesystems.
 */
export async function createOverlay(
	opts: CreateOverlayOptions,
): Promise<OverlayPaths> {
	const { baseRootfsPath, instanceDir } = opts;

	try {
		mkdirSync(instanceDir, { recursive: true });
	} catch (err) {
		throw new OverlayError(
			`Failed to create instance directory ${instanceDir}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	const rootfs = join(instanceDir, "rootfs.ext4");

	const proc = Bun.spawn(
		["cp", "--reflink=auto", baseRootfsPath, rootfs],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const exitCode = await proc.exited;

	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new OverlayError(
			`Failed to copy rootfs from ${baseRootfsPath} to ${rootfs}: ${stderr.trim()}`,
		);
	}

	return { rootfs, instanceDir };
}

/** Remove an instance's overlay directory and all its contents. */
export async function removeOverlay(instanceDir: string): Promise<void> {
	const proc = Bun.spawn(
		["rm", "-rf", instanceDir],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const exitCode = await proc.exited;

	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new OverlayError(
			`Failed to remove overlay directory ${instanceDir}: ${stderr.trim()}`,
		);
	}
}
