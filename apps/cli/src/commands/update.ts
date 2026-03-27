import { writeFileSync, renameSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

declare const BOILERHOUSE_VERSION: string;

const GITHUB_API =
	"https://api.github.com/repos/<org>/boilerhouse/releases/latest";
const DOWNLOAD_BASE =
	"https://github.com/<org>/boilerhouse/releases/download";

function currentVersion(): string {
	return typeof BOILERHOUSE_VERSION !== "undefined" ? BOILERHOUSE_VERSION : "dev";
}

function currentArch(): "amd64" | "arm64" {
	const res = Bun.spawnSync(["uname", "-m"], { stdout: "pipe" });
	const arch = new TextDecoder().decode(res.stdout).trim();
	if (arch === "aarch64" || arch === "arm64") return "arm64";
	return "amd64";
}

export async function updateCommand(): Promise<void> {
	const version = currentVersion();
	if (version === "dev") {
		console.error(
			"Cannot update a dev build. Install the official binary from GitHub Releases.",
		);
		process.exit(1);
	}

	console.log("Checking for updates...");

	let res: Response;
	try {
		res = await fetch(GITHUB_API, {
			headers: { "User-Agent": "boilerhouse-cli" },
			signal: AbortSignal.timeout(10000),
		});
	} catch (err) {
		console.error(
			"Failed to reach GitHub API:",
			err instanceof Error ? err.message : err,
		);
		process.exit(1);
	}

	if (!res.ok) {
		console.error(`GitHub API returned HTTP ${res.status}`);
		process.exit(1);
	}

	const { tag_name } = (await res.json()) as { tag_name: string };
	const latest = tag_name.replace(/^v/, "");

	if (latest === version) {
		console.log(`Already up to date (${version}).`);
		return;
	}

	const arch = currentArch();
	const artifact = `boilerhouse-linux-${arch}`;
	const downloadUrl = `${DOWNLOAD_BASE}/${tag_name}/${artifact}`;

	console.log(`Downloading boilerhouse v${latest} (linux-${arch})...`);

	let dlRes: Response;
	try {
		dlRes = await fetch(downloadUrl, {
			headers: { "User-Agent": "boilerhouse-cli" },
			signal: AbortSignal.timeout(120000),
		});
	} catch (err) {
		console.error("Download failed:", err instanceof Error ? err.message : err);
		process.exit(1);
	}

	if (!dlRes.ok) {
		console.error(`Download returned HTTP ${dlRes.status}`);
		process.exit(1);
	}

	const binaryData = Buffer.from(await dlRes.arrayBuffer());
	const tmpPath = join(tmpdir(), `boilerhouse-update-${Date.now()}`);

	writeFileSync(tmpPath, binaryData, { mode: 0o755 });

	const currentBinary = process.execPath;
	console.log(`Replacing ${currentBinary}...`);

	// Atomically replace the current binary
	chmodSync(tmpPath, 0o755);
	renameSync(tmpPath, currentBinary);

	console.log(`Updated to v${latest}. Restart running services to use the new version:`);
	console.log("  systemctl restart boilerhouse-podmand@boilerhouse");
	console.log("  systemctl restart boilerhouse-api   # if installed as a service");
}
