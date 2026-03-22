import { readFileSync, existsSync } from "node:fs";
import { DEFAULT_RUNTIME_SOCKET, DEFAULT_PODMAN_SOCKET, DEFAULT_SNAPSHOT_DIR } from "@boilerhouse/core";
import { createDaemon } from "@boilerhouse/boilerhouse-podmand";

/** Load key=value pairs from an env file into process.env (only if key not already set). */
function loadEnvFile(path: string): void {
	if (!existsSync(path)) return;
	const lines = readFileSync(path, "utf8").split("\n");
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const eqIdx = trimmed.indexOf("=");
		if (eqIdx === -1) continue;
		const key = trimmed.slice(0, eqIdx).trim();
		const value = trimmed.slice(eqIdx + 1).trim();
		if (key && !(key in process.env)) {
			process.env[key] = value;
		}
	}
}

export async function podmandStartCommand(): Promise<void> {
	// Load env file if env vars are not already set
	if (!process.env["HMAC_KEY"]) {
		loadEnvFile("/etc/boilerhouse/podmand.env");
	}

	const podmanSocketPath =
		process.env["PODMAN_SOCKET"] ??
		DEFAULT_PODMAN_SOCKET ??
		"/var/run/boilerhouse/podman.sock";
	const listenSocketPath = process.env["LISTEN_SOCKET"] ?? DEFAULT_RUNTIME_SOCKET;
	const snapshotDir = process.env["SNAPSHOT_DIR"] ?? DEFAULT_SNAPSHOT_DIR;
	const encryptionKey = process.env["BOILERHOUSE_ENCRYPTION_KEY"];
	const workloadsDir = process.env["WORKLOADS_DIR"];

	let daemon: { stop: () => void };
	try {
		daemon = await createDaemon({
			podmanSocketPath,
			listenSocketPath,
			snapshotDir,
			encryptionKey,
			workloadsDir,
			managePodman: true,
		});
	} catch (err) {
		console.error(
			"Failed to start boilerhouse-podmand:",
			err instanceof Error ? err.message : err,
		);
		process.exit(1);
	}

	console.log(`boilerhouse-podmand listening on ${listenSocketPath}`);
	console.log(`  podman socket: ${podmanSocketPath} (managed)`);
	console.log(`  snapshot dir:  ${snapshotDir}`);

	process.on("SIGTERM", () => {
		console.log("Received SIGTERM, shutting down...");
		daemon.stop();
		process.exit(0);
	});

	process.on("SIGINT", () => {
		console.log("Received SIGINT, shutting down...");
		daemon.stop();
		process.exit(0);
	});
}
