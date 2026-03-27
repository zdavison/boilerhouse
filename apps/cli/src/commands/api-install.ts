import { existsSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { apiServiceUnit } from "../embedded/api.service";

const CONFIG_DIR = "/etc/boilerhouse";
const API_ENV = `${CONFIG_DIR}/api.env`;
const UNIT_PATH = "/etc/systemd/system/boilerhouse-api.service";

/** Generate a cryptographically random hex string of `bytes` bytes. */
function randomHex(bytes: number): string {
	const buf = new Uint8Array(bytes);
	crypto.getRandomValues(buf);
	return Array.from(buf)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export function apiInstallCommand(opts: { binaryPath?: string; dataDir?: string }): void {
	if (process.getuid?.() !== 0) {
		console.error("This command must be run as root.");
		process.exit(1);
	}

	const binaryPath = opts.binaryPath ?? process.execPath;
	const dataDir = opts.dataDir ?? "/var/lib/boilerhouse";

	// Generate api.env if it doesn't exist yet
	if (!existsSync(API_ENV)) {
		const secretKey = randomHex(32);
		writeFileSync(
			API_ENV,
			[
				`RUNTIME_TYPE=podman`,
				`RUNTIME_SOCKET=/run/boilerhouse/runtime.sock`,
				`SNAPSHOT_DIR=${dataDir}/snapshots`,
				`STORAGE_PATH=${dataDir}/data`,
				`DB_PATH=${dataDir}/boilerhouse.db`,
				`BOILERHOUSE_SECRET_KEY=${secretKey}`,
				`LISTEN_HOST=127.0.0.1`,
				`PORT=3000`,
				`METRICS_PORT=9464`,
				`METRICS_HOST=127.0.0.1`,
				`MAX_INSTANCES=100`,
				``,
			].join("\n"),
			{ mode: 0o600 },
		);
		console.log(`Generated ${API_ENV}`);
	}

	const unit = apiServiceUnit(binaryPath, dataDir);
	writeFileSync(UNIT_PATH, unit, { mode: 0o644 });
	console.log(`Wrote ${UNIT_PATH}`);

	execSync("systemctl daemon-reload", { stdio: "inherit" });
	execSync("systemctl enable --now boilerhouse-api", { stdio: "inherit" });
	console.log("boilerhouse-api service enabled and started.");
}
