import { readFileSync, existsSync } from "node:fs";

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

export async function apiStartCommand(): Promise<void> {
	// Load env file if BOILERHOUSE_SECRET_KEY is not already set
	if (!process.env["BOILERHOUSE_SECRET_KEY"]) {
		loadEnvFile("/etc/boilerhouse/api.env");
	}

	// Importing server.ts starts the API server (all init runs at module load time)
	await import("@boilerhouse/api");
}
