export interface RuntimeAvailability {
	/** Always available */
	fake: true;
	/** `docker info` succeeds */
	docker: boolean;
	/**
	 * A boilerhouse deployment is reachable via `BOILERHOUSE_K8S_API_URL`.
	 * Set this env var to the API base URL (e.g. `http://localhost:8080`)
	 * before running kubernetes e2e tests.
	 */
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
 * Kubernetes e2e is available when `BOILERHOUSE_K8S_API_URL` is set.
 *
 * Typical setup: deploy the operator + API to a cluster, then set the env var
 * to the API's external or port-forwarded address before running tests:
 *
 *   BOILERHOUSE_K8S_API_URL=http://localhost:8080 bun test tests/e2e/ --timeout 120000
 */
function kubernetesAvailable(): boolean {
	return !!process.env.BOILERHOUSE_K8S_API_URL;
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
