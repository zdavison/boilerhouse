import { existsSync } from "node:fs";

export interface RuntimeAvailability {
	/** Always available */
	fake: true;
	/** `docker info` succeeds */
	docker: boolean;
	/** `firecracker --version` succeeds and /dev/kvm exists */
	firecracker: boolean;
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
	const docker =
		commandSucceeds("docker", ["info"]);

	const firecracker =
		process.platform === "linux" &&
		existsSync("/dev/kvm") &&
		commandSucceeds("firecracker", ["--version"]);

	return {
		fake: true,
		docker,
		firecracker,
	};
}
