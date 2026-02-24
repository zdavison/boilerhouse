export interface RuntimeAvailability {
	/** Always available */
	fake: true;
	/** `docker info` succeeds */
	docker: boolean;
	/** `podman info` succeeds */
	podman: boolean;
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

export function detectRuntimes(): RuntimeAvailability {
	const docker = commandSucceeds("docker", ["info"]);
	const podman = commandSucceeds("podman", ["info"]);

	return {
		fake: true,
		docker,
		podman,
	};
}
