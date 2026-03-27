import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CACHE_FILE = "/var/lib/boilerhouse/.update-check";
const GITHUB_RELEASES_URL =
	"https://api.github.com/repos/<org>/boilerhouse/releases/latest";

interface UpdateCache {
	lastCheck: number;
	latestVersion: string | null;
}

/** Non-blocking check, prints to stderr if an update is available. */
export function checkForUpdatesInBackground(currentVersion: string): void {
	// Fire-and-forget — never blocks the main command
	checkForUpdates(currentVersion).catch(() => {});
}

async function checkForUpdates(currentVersion: string): Promise<void> {
	const cache = readCache();
	if (cache && Date.now() - cache.lastCheck < CHECK_INTERVAL_MS) {
		if (cache.latestVersion && cache.latestVersion !== currentVersion) {
			printUpdateNotice(currentVersion, cache.latestVersion);
		}
		return;
	}

	let res: Response;
	try {
		res = await fetch(GITHUB_RELEASES_URL, {
			headers: { "User-Agent": "boilerhouse-cli" },
			signal: AbortSignal.timeout(5000),
		});
	} catch {
		return;
	}

	if (!res.ok) return;

	const { tag_name } = (await res.json()) as { tag_name: string };
	const latest = tag_name.replace(/^v/, "");
	writeCache({ lastCheck: Date.now(), latestVersion: latest });

	if (latest !== currentVersion) {
		printUpdateNotice(currentVersion, latest);
	}
}

function printUpdateNotice(current: string, latest: string): void {
	console.error(
		`\nA new version of boilerhouse is available: v${latest} (current: v${current})`,
	);
	console.error("Run `boilerhouse update` to install it.\n");
}

function readCache(): UpdateCache | null {
	try {
		const data = readFileSync(CACHE_FILE, "utf8");
		return JSON.parse(data) as UpdateCache;
	} catch {
		return null;
	}
}

function writeCache(cache: UpdateCache): void {
	try {
		mkdirSync("/var/lib/boilerhouse", { recursive: true });
		writeFileSync(CACHE_FILE, JSON.stringify(cache), { mode: 0o600 });
	} catch {
		// Best-effort — ignore if we can't write (e.g. no permissions)
	}
}
