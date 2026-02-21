import { existsSync } from "node:fs";
import { join } from "node:path";
import { FirecrackerProcessError, JailerProcessError } from "./errors";

export interface FirecrackerProcess {
	/** The underlying Bun subprocess. */
	proc: ReturnType<typeof Bun.spawn>;
	/** Path to the API Unix socket. */
	socketPath: string;
	/** Path to the Firecracker log file. */
	logPath: string;
	/** Kill the Firecracker process. */
	kill(): void;
	/**
	 * Wait for the API socket file to appear on disk.
	 * @param timeoutMs Maximum wait time in milliseconds.
	 * @default 5000
	 */
	waitForSocket(timeoutMs?: number): Promise<void>;
}

export interface SpawnOptions {
	/** Path to the Firecracker binary. */
	binaryPath: string;
	/** Path where the API socket will be created. */
	socketPath: string;
	/** Path for Firecracker log output. */
	logPath: string;
}

const POLL_INTERVAL_MS = 50;
const DEFAULT_TIMEOUT_MS = 5000;

/** Spawn a Firecracker VMM process and return a handle for managing it. */
export function spawnFirecracker(opts: SpawnOptions): FirecrackerProcess {
	const { binaryPath, socketPath, logPath } = opts;

	const proc = Bun.spawn(
		[
			binaryPath,
			"--api-sock",
			socketPath,
			"--log-path",
			logPath,
			"--level",
			"Warning",
			"--boot-timer",
		],
		{
			stdout: "ignore",
			stderr: "ignore",
		},
	);

	return {
		proc,
		socketPath,
		logPath,
		kill() {
			proc.kill();
		},
		async waitForSocket(timeoutMs = DEFAULT_TIMEOUT_MS) {
			const deadline = Date.now() + timeoutMs;

			while (!existsSync(socketPath)) {
				if (Date.now() > deadline) {
					throw new FirecrackerProcessError(
						`Firecracker socket did not appear at ${socketPath} within ${timeoutMs}ms`,
					);
				}
				await Bun.sleep(POLL_INTERVAL_MS);
			}
		},
	};
}

// ── Jailer process spawning ────────────────────────────────────────────────

export interface JailerSpawnOptions {
	/** Jailer VM ID (typically the instance ID). */
	jailerId: string;
	/**
	 * Resolved absolute path to the Firecracker binary.
	 * Must be resolved via `readlink -f` for jailer compatibility.
	 */
	execFile: string;
	/** Path to the jailer binary. */
	jailerPath: string;
	/** UID for the jailed process. */
	uid: number;
	/** GID for the jailed process. */
	gid: number;
	/** Base directory for chroot jails. */
	chrootBaseDir: string;
	/** Path to the network namespace. */
	netnsPath: string;
	/** Whether the jailer should daemonize. */
	daemonize: boolean;
	/** Whether to create a new PID namespace. */
	newPidNs: boolean;
	/** Cgroup version to use (1 or 2). */
	cgroupVersion: 1 | 2;
	/** Optional cgroup settings. */
	cgroups?: string[];
}

export interface JailedProcess {
	/** Host-side API socket path. */
	socketPath: string;
	/** Chroot root directory. */
	chrootRoot: string;
	/**
	 * Waits for the jailer to set up the API socket.
	 * With --daemonize, first awaits process exit (jailer forks), then polls socket.
	 * @param timeoutMs Maximum wait time in milliseconds.
	 * @default 5000
	 */
	waitForSocket(timeoutMs?: number): Promise<void>;
	/** Kills the jailed Firecracker process by reading its PID file. */
	kill(): Promise<void>;
}

/** Computes the host-side socket path for a jailed VM. */
export function computeJailedSocketPath(
	chrootBaseDir: string,
	jailerId: string,
): string {
	return join(
		chrootBaseDir,
		"firecracker",
		jailerId,
		"root",
		"run",
		"firecracker.socket",
	);
}

/** Builds the command-line arguments for the jailer binary. */
export function buildJailerArgs(opts: JailerSpawnOptions): string[] {
	const args: string[] = [
		"--id", opts.jailerId,
		"--exec-file", opts.execFile,
		"--uid", String(opts.uid),
		"--gid", String(opts.gid),
		"--chroot-base-dir", opts.chrootBaseDir,
		"--netns", opts.netnsPath,
		"--cgroup-version", String(opts.cgroupVersion),
	];

	if (opts.daemonize) args.push("--daemonize");
	if (opts.newPidNs) args.push("--new-pid-ns");

	if (opts.cgroups) {
		for (const cg of opts.cgroups) {
			args.push("--cgroup", cg);
		}
	}

	// Firecracker args after separator
	args.push("--", "--api-sock", "/run/firecracker.socket");

	return args;
}

/**
 * Resolves the absolute path to a binary via `readlink -f`.
 * The jailer requires an absolute, resolved path for --exec-file.
 */
export async function resolveExecFile(binaryPath: string): Promise<string> {
	const proc = Bun.spawn(["readlink", "-f", binaryPath], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new JailerProcessError(
			`Failed to resolve exec file '${binaryPath}': ${stderr.trim()}`,
			exitCode,
		);
	}
	const stdout = await new Response(proc.stdout).text();
	return stdout.trim();
}

/**
 * Spawns a Firecracker VM via the jailer binary with `sudo`.
 * Returns a handle for managing the jailed process.
 */
export function spawnJailer(opts: JailerSpawnOptions): JailedProcess {
	const args = buildJailerArgs(opts);
	const socketPath = computeJailedSocketPath(opts.chrootBaseDir, opts.jailerId);
	const chrootRoot = join(opts.chrootBaseDir, "firecracker", opts.jailerId, "root");

	const proc = Bun.spawn(
		["sudo", opts.jailerPath, ...args],
		{
			stdout: "ignore",
			stderr: "pipe",
		},
	);

	return {
		socketPath,
		chrootRoot,
		async waitForSocket(timeoutMs = DEFAULT_TIMEOUT_MS) {
			if (opts.daemonize) {
				// With --daemonize, the jailer exits after forking
				const exitCode = await proc.exited;
				if (exitCode !== 0) {
					const stderr = await new Response(proc.stderr).text();
					throw new JailerProcessError(
						`Jailer exited with code ${exitCode}: ${stderr.trim()}`,
						exitCode,
					);
				}
			}

			// Poll for socket
			const deadline = Date.now() + timeoutMs;
			while (!existsSync(socketPath)) {
				if (Date.now() > deadline) {
					throw new JailerProcessError(
						`Jailed Firecracker socket did not appear at ${socketPath} within ${timeoutMs}ms`,
					);
				}
				await Bun.sleep(POLL_INTERVAL_MS);
			}
		},
		async kill() {
			const pidFile = join(chrootRoot, "firecracker.pid");
			if (existsSync(pidFile)) {
				const pid = (await Bun.file(pidFile).text()).trim();
				const killProc = Bun.spawn(
					["sudo", "kill", "-9", pid],
					{ stdout: "ignore", stderr: "ignore" },
				);
				await killProc.exited;
			} else {
				// Fallback: kill the jailer process itself
				proc.kill();
			}
		},
	};
}
