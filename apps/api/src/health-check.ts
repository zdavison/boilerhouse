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
): Promise<void> {
	const deadline = Date.now() + config.timeoutMs;
	let consecutiveFailures = 0;

	while (Date.now() < deadline) {
		try {
			const healthy = await check();
			if (healthy) {
				return;
			}
			consecutiveFailures++;
		} catch {
			consecutiveFailures++;
		}

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
export function createHttpCheck(url: string): HealthCheckFn {
	return async () => {
		const res = await fetch(url, {
			signal: AbortSignal.timeout(5000),
		});
		return res.status === 200;
	};
}

/** Creates a health check that executes a command in the guest VM. Exit code 0 = healthy. */
export function createExecCheck(
	runtime: Runtime,
	handle: InstanceHandle,
	command: string[],
): HealthCheckFn {
	return async () => {
		const result = await runtime.exec(handle, command);
		return result.exitCode === 0;
	};
}
