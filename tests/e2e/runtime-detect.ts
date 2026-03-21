import { existsSync } from "node:fs";
import { DEFAULT_RUNTIME_SOCKET } from "@boilerhouse/core";

export interface RuntimeAvailability {
	/** Always available */
	fake: true;
	/** `docker info` succeeds */
	docker: boolean;
	/** Podman API socket exists and is connectable */
	podman: boolean;
	/** Minikube `boilerhouse-test` profile is running and reachable */
	kubernetes: boolean;
}

function commandSucceeds(cmd: string, args: string[]): boolean {
	try {
		const result = Bun.spawnSync([cmd, ...args], {
			stdout: "ignore",
			stderr: "ignore",
		});
		return result.exitCode === 0;
	} catch {
		return false;
	}
}

/**
 * Check that the podman API socket exists AND the daemon is responsive.
 * existsSync alone is not enough — stale socket files from crashed daemons
 * cause tests to hang instead of skipping.
 */
function podmanSocketAvailable(): boolean {
	const socketPath = process.env.RUNTIME_SOCKET ?? DEFAULT_RUNTIME_SOCKET;
	try {
		if (!existsSync(socketPath)) return false;
		const result = Bun.spawnSync(
			["curl", "--unix-socket", socketPath, "--max-time", "2", "-sf", "http://localhost/healthz"],
			{ stdout: "pipe", stderr: "ignore" },
		);
		return result.exitCode === 0;
	} catch {
		return false;
	}
}

/**
 * Check that minikube is running with our test profile and the K8s API is reachable.
 */
function kubernetesAvailable(): boolean {
	try {
		const status = Bun.spawnSync(
			["minikube", "status", "-p", "boilerhouse-test", "-o", "json"],
			{ stdout: "pipe", stderr: "ignore" },
		);
		if (status.exitCode !== 0) return false;

		const probe = Bun.spawnSync(
			["kubectl", "--context", "boilerhouse-test", "cluster-info"],
			{ stdout: "ignore", stderr: "ignore" },
		);
		return probe.exitCode === 0;
	} catch {
		return false;
	}
}

export function detectRuntimes(): RuntimeAvailability {
	const docker = commandSucceeds("docker", ["info"]);
	const podman = podmanSocketAvailable();
	const kubernetes = kubernetesAvailable();

	return {
		fake: true,
		docker,
		podman,
		kubernetes,
	};
}
