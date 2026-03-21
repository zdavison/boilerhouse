import { existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { podmandServiceUnit } from "../embedded/podmand.service";
import { NFTABLES_CONF } from "../embedded/nftables.conf";

const CONFIG_DIR = "/etc/boilerhouse";
const DATA_DIR = "/var/lib/boilerhouse";
const RUN_DIR = "/run/boilerhouse";
const PODMAND_ENV = `${CONFIG_DIR}/podmand.env`;
const API_ENV = `${CONFIG_DIR}/api.env`;
const UNIT_PATH = "/etc/systemd/system/boilerhouse-podmand@.service";

function log(msg: string): void {
	console.log(`==> ${msg}`);
}

function warn(msg: string): void {
	console.error(`WARNING: ${msg}`);
}

function run(cmd: string): void {
	execSync(cmd, { stdio: "inherit" });
}

/** Check if a command exists on PATH. */
function commandExists(cmd: string): boolean {
	const res = spawnSync("which", [cmd], { encoding: "utf8" });
	return res.status === 0;
}

/** Read /etc/os-release and return true if Ubuntu or Debian. */
function isUbuntuOrDebian(): boolean {
	try {
		const content = readFileSync("/etc/os-release", "utf8");
		return /ubuntu|debian/i.test(content);
	} catch {
		return false;
	}
}

/** Generate a cryptographically random hex string of `bytes` bytes. */
function randomHex(bytes: number): string {
	const buf = new Uint8Array(bytes);
	crypto.getRandomValues(buf);
	return Array.from(buf)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

/** Wait up to `maxSec` seconds for a socket file to appear. */
async function waitForSocket(path: string, maxSec: number): Promise<boolean> {
	for (let i = 0; i < maxSec * 10; i++) {
		if (existsSync(path)) return true;
		await new Promise((r) => setTimeout(r, 100));
	}
	return false;
}

export interface HostInstallOptions {
	skipFirewall?: boolean;
	binaryPath?: string;
	dataDir?: string;
}

export async function hostInstallCommand(opts: HostInstallOptions): Promise<void> {
	// ── Preflight ────────────────────────────────────────────────────────────

	if (process.getuid?.() !== 0) {
		console.error("This command must be run as root.");
		process.exit(1);
	}

	if (!isUbuntuOrDebian()) {
		warn("This installer is tested on Ubuntu/Debian. Other distros may need manual adjustments.");
	}

	const binaryPath = opts.binaryPath ?? process.execPath;
	const dataDir = opts.dataDir ?? DATA_DIR;

	// ── 1. System packages ───────────────────────────────────────────────────

	log("Installing system packages");
	process.env["DEBIAN_FRONTEND"] = "noninteractive";
	run("apt-get update -qq");
	run("apt-get install -y -qq podman crun criu nftables curl");

	// ── 2. Verify CRIU ────────────────────────────────────────────────────────

	log("Verifying CRIU");
	const criuCheck = spawnSync("criu", ["check"], { encoding: "utf8" });
	if (criuCheck.status === 0) {
		console.log("  CRIU check passed");
	} else {
		warn("criu check failed — checkpoint/restore may not work. Check kernel config.");
	}

	const podmanInfo = spawnSync("podman", ["info"], { encoding: "utf8" });
	if (/criuEnabled.*true/i.test(podmanInfo.stdout)) {
		console.log("  Podman reports CRIU enabled");
	} else {
		warn("Podman does not report CRIU as enabled");
	}

	// ── 3. System user ────────────────────────────────────────────────────────

	const userCheck = spawnSync("id", ["boilerhouse"], { encoding: "utf8" });
	if (userCheck.status === 0) {
		log("User 'boilerhouse' already exists");
	} else {
		log("Creating 'boilerhouse' system user");
		run("useradd --system --create-home --shell /usr/sbin/nologin boilerhouse");
	}

	// ── 4. Directories ────────────────────────────────────────────────────────

	log("Creating directories");
	mkdirSync(`${dataDir}/data`, { recursive: true });
	mkdirSync(`${dataDir}/snapshots`, { recursive: true });
	mkdirSync(CONFIG_DIR, { recursive: true });
	mkdirSync(RUN_DIR, { recursive: true });

	run(`chown boilerhouse:boilerhouse ${dataDir}/data`);
	chmodSync(`${dataDir}/snapshots`, 0o700);

	// ── 5. Generate secrets ──────────────────────────────────────────────────

	if (existsSync(PODMAND_ENV)) {
		log("podmand.env already exists — skipping secret generation");
	} else {
		log("Generating secrets");

		const hmacKey = randomHex(32);
		const secretKey = randomHex(32);

		writeFileSync(
			PODMAND_ENV,
			[
				`PODMAN_SOCKET=/run/boilerhouse/podman.sock`,
				`LISTEN_SOCKET=/run/boilerhouse/runtime.sock`,
				`SNAPSHOT_DIR=${dataDir}/snapshots`,
				`HMAC_KEY=${hmacKey}`,
				``,
			].join("\n"),
			{ mode: 0o600 },
		);

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

		log(`Secrets written to ${CONFIG_DIR}/`);
	}

	// ── 6. Install podmand systemd service ────────────────────────────────────

	log("Installing boilerhouse-podmand systemd service");

	const unitContent = podmandServiceUnit(binaryPath, dataDir);
	writeFileSync(UNIT_PATH, unitContent, { mode: 0o644 });

	run("systemctl daemon-reload");
	run("systemctl enable --now boilerhouse-podmand@boilerhouse");

	// ── 7. Wait for socket ────────────────────────────────────────────────────

	log("Waiting for podmand socket...");
	const socketReady = await waitForSocket("/run/boilerhouse/runtime.sock", 30);
	if (socketReady) {
		log("podmand is running");
	} else {
		warn(
			"Runtime socket not found after 30s. Check: journalctl -u boilerhouse-podmand@boilerhouse",
		);
	}

	// ── 8. Firewall (optional) ────────────────────────────────────────────────

	if (opts.skipFirewall) {
		log("Skipping firewall setup (--skip-firewall)");
	} else {
		log("Configuring nftables firewall");
		writeFileSync("/etc/nftables.conf", NFTABLES_CONF, { mode: 0o644 });
		run("systemctl enable --now nftables");
		run("nft -f /etc/nftables.conf");
	}

	// ── Done ──────────────────────────────────────────────────────────────────

	console.log("");
	console.log("============================================");
	console.log("  Boilerhouse host setup complete");
	console.log("============================================");
	console.log("");
	console.log(`  podmand:    systemctl status boilerhouse-podmand@boilerhouse`);
	console.log(`  socket:     /run/boilerhouse/runtime.sock`);
	console.log(`  config:     ${CONFIG_DIR}/`);
	console.log(`  data:       ${dataDir}/`);
	console.log("");
	console.log(`  To run the API:`);
	console.log(`    ${binaryPath} api start`);
	console.log(`  Or install as a systemd service:`);
	console.log(`    ${binaryPath} api install`);
	console.log("");
}

/** Check if a systemd unit is active. */
function isUnitActive(unit: string): boolean {
	const res = spawnSync("systemctl", ["is-active", unit], { encoding: "utf8" });
	return res.stdout.trim() === "active";
}

export function hostStatusCommand(): void {
	console.log("Boilerhouse host status\n");

	// podmand
	const podmandActive = isUnitActive("boilerhouse-podmand@boilerhouse");
	console.log(`  podmand service:  ${podmandActive ? "running" : "stopped"}`);

	// socket
	const socketExists = existsSync("/run/boilerhouse/runtime.sock");
	console.log(`  runtime socket:   ${socketExists ? "present" : "missing"} (/run/boilerhouse/runtime.sock)`);

	// CRIU
	const criuCheck = spawnSync("criu", ["check"], { encoding: "utf8" });
	console.log(`  CRIU:             ${criuCheck.status === 0 ? "ok" : "not available"}`);

	// Disk
	if (commandExists("df")) {
		const df = spawnSync("df", ["-h", DATA_DIR], { encoding: "utf8" });
		const lines = df.stdout.trim().split("\n");
		const dataLine = lines[1];
		if (dataLine) {
			const parts = dataLine.split(/\s+/);
			console.log(
				`  disk (${DATA_DIR}):  ${parts[3] ?? "?"} available of ${parts[1] ?? "?"} (${parts[4] ?? "?"} used)`,
			);
		}
	}

	console.log("");
}

export function hostUninstallCommand(): void {
	if (process.getuid?.() !== 0) {
		console.error("This command must be run as root.");
		process.exit(1);
	}

	log("Stopping and disabling boilerhouse-podmand");
	spawnSync("systemctl", ["disable", "--now", "boilerhouse-podmand@boilerhouse"], {
		stdio: "inherit",
	});
	spawnSync("systemctl", ["disable", "--now", "boilerhouse-api"], {
		stdio: "inherit",
	});

	log("Removing systemd unit files");
	spawnSync("rm", ["-f", UNIT_PATH, "/etc/systemd/system/boilerhouse-api.service"], {
		stdio: "inherit",
	});
	run("systemctl daemon-reload");

	// ── Revert nftables firewall ──────────────────────────────────────────────
	// If the current /etc/nftables.conf contains our marker comment, remove it
	// and flush the ruleset so the host returns to an open firewall.
	log("Reverting nftables firewall");
	try {
		const nftConf = readFileSync("/etc/nftables.conf", "utf8");
		if (nftConf.includes("Boilerhouse VM firewall")) {
			spawnSync("rm", ["-f", "/etc/nftables.conf"], { stdio: "inherit" });
			// Flush all rules — returns to kernel default (accept all)
			spawnSync("nft", ["flush", "ruleset"], { stdio: "inherit" });
			spawnSync("systemctl", ["disable", "--now", "nftables"], { stdio: "inherit" });
			console.log("  Boilerhouse firewall rules removed");
		} else {
			console.log("  /etc/nftables.conf was modified — leaving in place");
		}
	} catch {
		// No nftables.conf or nft not installed — nothing to revert
	}

	console.log("");
	console.log("Boilerhouse services removed.");
	console.log(
		`Data and config are preserved at ${DATA_DIR}/ and ${CONFIG_DIR}/.`,
	);
	console.log(
		"To fully remove: rm -rf /var/lib/boilerhouse /etc/boilerhouse && userdel boilerhouse",
	);
	console.log("");
}
