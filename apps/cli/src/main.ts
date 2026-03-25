import { Command } from "commander";
import { checkForUpdatesInBackground } from "./update-check";
import { versionCommand } from "./commands/version";
import { apiInstallCommand } from "./commands/api-install";

declare const BOILERHOUSE_VERSION: string;

function getVersion(): string {
	return typeof BOILERHOUSE_VERSION !== "undefined" ? BOILERHOUSE_VERSION : "dev";
}

const program = new Command();

program
	.name("boilerhouse")
	.description("Boilerhouse — container runtime manager")
	.version(getVersion(), "-V, --version");

// ── api ───────────────────────────────────────────────────────────────────────

const api = program.command("api").description("API server (use docker-compose for production)");

api
	.command("start")
	.description("Run the API server on the host (foreground, for dev/testing)")
	.action(async () => {
		const { apiStartCommand } = await import("./commands/api-start");
		await apiStartCommand();
	});

api
	.command("install")
	.description("Install the API as a systemd service on the host (alternative to Docker)")
	.option("--binary-path <path>", "Path to the boilerhouse binary (default: current executable)")
	.option("--data-dir <path>", "Data directory (default: /var/lib/boilerhouse)")
	.action((opts: { binaryPath?: string; dataDir?: string }) => {
		apiInstallCommand({ binaryPath: opts.binaryPath, dataDir: opts.dataDir });
		checkForUpdatesInBackground(getVersion());
	});

// ── update / version ──────────────────────────────────────────────────────────

program
	.command("update")
	.description("Download and install the latest version")
	.action(async () => {
		const { updateCommand } = await import("./commands/update");
		await updateCommand();
	});

program
	.command("version")
	.description("Print version + commit")
	.action(() => {
		versionCommand();
	});

program.parse(process.argv);
