import { existsSync } from "node:fs";
import { FirecrackerProcessError } from "./errors";

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
