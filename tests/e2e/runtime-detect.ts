export interface RuntimeAvailability {
	/** Always available */
	fake: true;
	/** `docker info` succeeds */
	docker: boolean;
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
	const kubernetes = kubernetesAvailable();

	return {
		fake: true,
		docker,
		kubernetes,
	};
}
