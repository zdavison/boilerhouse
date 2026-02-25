import { existsSync } from "node:fs";

export interface RuntimeAvailability {
	/** Always available */
	fake: true;
	/** `docker info` succeeds */
	docker: boolean;
	/** Podman API socket exists and is connectable */
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

function podmanSocketAvailable(): boolean {
	const socketPath = process.env.PODMAN_SOCKET ?? "/run/boilerhouse/podman.sock";
	try {
		return existsSync(socketPath);
	} catch {
		return false;
	}
}

export function detectRuntimes(): RuntimeAvailability {
	const docker = commandSucceeds("docker", ["info"]);
	const podman = podmanSocketAvailable();

	return {
		fake: true,
		docker,
		podman,
	};
}
