import type { Runtime, InstanceHandle } from "@boilerhouse/core";

export interface HealthConfig {
	/** Interval between health check polls in ms. */
	interval: number;
	/** Number of consecutive failures before aborting. */
	unhealthyThreshold: number;
	/** Overall timeout deadline in ms. */
	timeoutMs: number;
}

/** A probe-agnostic health check function. Returns `true` when healthy. */
export type HealthCheckFn = () => Promise<boolean>;

/** A function that runs a health check loop. Resolves when healthy, rejects on timeout. */
export type HealthChecker = (check: HealthCheckFn, config: HealthConfig, onLog?: (line: string) => void) => Promise<void>;

export class HealthCheckTimeoutError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "HealthCheckTimeoutError";
	}
}

/**
 * Polls a health check function until it returns `true`.
 *
 * Fails if:
 * - `unhealthyThreshold` consecutive `false`/throw results are received
 * - The overall `timeoutMs` deadline elapses
 */
export async function pollHealth(
	check: HealthCheckFn,
	config: HealthConfig,
	onLog?: (line: string) => void,
): Promise<void> {
	const deadline = Date.now() + config.timeoutMs;
	let consecutiveFailures = 0;
	let attempt = 0;

	while (Date.now() < deadline) {
		attempt++;
		try {
			const healthy = await check();
			if (healthy) {
				return;
			}
			consecutiveFailures++;
		} catch (err) {
			consecutiveFailures++;
			onLog?.(`Health check attempt ${attempt} threw: ${err instanceof Error ? err.message : String(err)}`);
		}

		onLog?.(`Health check attempt ${attempt} failed (${consecutiveFailures}/${config.unhealthyThreshold} consecutive failures)`);

		if (consecutiveFailures >= config.unhealthyThreshold) {
			throw new HealthCheckTimeoutError(
				`Health check failed after ${consecutiveFailures} consecutive failures`,
			);
		}

		await new Promise((resolve) => setTimeout(resolve, config.interval));
	}

	throw new HealthCheckTimeoutError(
		`Health check timed out after ${config.timeoutMs}ms`,
	);
}

/** Creates a health check that fetches an HTTP URL and expects status 200. */
export function createHttpCheck(url: string, onLog?: (line: string) => void): HealthCheckFn {
	return async () => {
		const res = await fetch(url, {
			signal: AbortSignal.timeout(5000),
			headers: { Connection: "close" },
		});
		if (res.status !== 200) {
			onLog?.(`HTTP health check: status=${res.status} (expected 200)`);
			return false;
		}
		return true;
	};
}

/** Creates a health check that executes a command in the instance. Exit code 0 = healthy. */
export function createExecCheck(
	runtime: Runtime,
	handle: InstanceHandle,
	command: string[],
	onLog?: (line: string) => void,
): HealthCheckFn {
	return async () => {
		const result = await runtime.exec(handle, command);
		if (result.exitCode !== 0) {
			const stdout = result.stdout.slice(0, 200);
			const stderr = result.stderr.slice(0, 200);
			onLog?.(`Exec health check: exitCode=${result.exitCode} stdout="${stdout}" stderr="${stderr}"`);
			return false;
		}
		return true;
	};
}
