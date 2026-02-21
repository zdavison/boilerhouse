import { resolve, dirname } from "node:path";
import { detectRuntimes, type RuntimeAvailability } from "./runtime-detect";

export interface RuntimeEntry {
	name: string;
	capabilities: {
		snapshot: boolean;
		exec: boolean;
		networking: boolean;
	};
	/** Workload TOML fixture path for this runtime */
	workloadFixture: string;
	/**
	 * Workload TOML fixture that will fail during instance creation.
	 * Used by error-recovery tests. Mechanism is runtime-specific:
	 * - fake: server started with failOn config
	 * - docker: workload references a nonexistent image
	 * - firecracker: workload references a missing kernel/rootfs
	 */
	brokenWorkloadFixture: string;
	/** Verify no orphaned resources exist via runtime CLI. No-op for fake. */
	verifyCleanup: () => Promise<void>;
	/** Check if an instance is running via runtime CLI. Always false for fake after destroy. */
	isInstanceRunning: (instanceId: string) => Promise<boolean>;
}

const FIXTURES_DIR = resolve(dirname(import.meta.path), "fixtures");

function fixturePath(name: string): string {
	return resolve(FIXTURES_DIR, name);
}

const fakeEntry: RuntimeEntry = {
	name: "fake",
	capabilities: {
		snapshot: true,
		exec: true,
		networking: false,
	},
	workloadFixture: fixturePath("workload-fake.toml"),
	brokenWorkloadFixture: fixturePath("workload-fake-broken.toml"),
	verifyCleanup: async () => {
		// No-op for fake runtime
	},
	isInstanceRunning: async () => false,
};

const dockerEntry: RuntimeEntry = {
	name: "docker",
	capabilities: {
		snapshot: false,
		exec: true,
		networking: true,
	},
	workloadFixture: fixturePath("workload-docker.toml"),
	brokenWorkloadFixture: fixturePath("workload-docker-broken.toml"),
	verifyCleanup: async () => {
		const result = Bun.spawnSync([
			"docker",
			"ps",
			"-q",
			"--filter",
			"label=boilerhouse",
		]);
		const output = result.stdout.toString().trim();
		if (output.length > 0) {
			throw new Error(
				`Orphaned Docker containers found: ${output}`,
			);
		}
	},
	isInstanceRunning: async (instanceId: string) => {
		const result = Bun.spawnSync([
			"docker",
			"inspect",
			"--format",
			"{{.State.Running}}",
			instanceId,
		]);
		return result.stdout.toString().trim() === "true";
	},
};

const firecrackerEntry: RuntimeEntry = {
	name: "firecracker",
	capabilities: {
		snapshot: true,
		exec: false,
		networking: true,
	},
	workloadFixture: fixturePath("workload-firecracker.toml"),
	brokenWorkloadFixture: fixturePath("workload-firecracker-broken.toml"),
	verifyCleanup: async () => {
		const { existsSync, readdirSync } = await import("node:fs");
		const jailerDir = "/srv/jailer/";
		if (existsSync(jailerDir)) {
			const entries = readdirSync(jailerDir);
			if (entries.length > 0) {
				throw new Error(
					`Orphaned jailer chroot dirs: ${entries.join(", ")}`,
				);
			}
		}
	},
	isInstanceRunning: async (instanceId: string) => {
		const result = Bun.spawnSync([
			"pgrep",
			"-f",
			instanceId,
		]);
		return result.exitCode === 0;
	},
};

const ALL_ENTRIES: Record<string, RuntimeEntry> = {
	fake: fakeEntry,
	docker: dockerEntry,
	firecracker: firecrackerEntry,
};

/**
 * Runtimes that have a working Runtime implementation wired into startE2EServer.
 * Docker and Firecracker entries are defined above for when their runtimes are added.
 */
const IMPLEMENTED_RUNTIMES = new Set(["fake"]);

/**
 * Returns runtime entries filtered to only those available on this system.
 * Always includes FakeRuntime. Includes real runtimes only if detected.
 *
 * Override with `BOILERHOUSE_E2E_RUNTIMES` env var (comma-separated list).
 * When set, only the listed runtimes run (still skipped if not actually available).
 */
export function availableRuntimes(): RuntimeEntry[] {
	const detected: RuntimeAvailability = detectRuntimes();

	const envOverride = process.env.BOILERHOUSE_E2E_RUNTIMES;
	let requested: string[];

	if (envOverride) {
		requested = envOverride.split(",").map((s) => s.trim().toLowerCase());
	} else {
		requested = Object.keys(ALL_ENTRIES);
	}

	const result: RuntimeEntry[] = [];

	for (const name of requested) {
		const entry = ALL_ENTRIES[name];
		if (!entry) continue;

		const isAvailable = detected[name as keyof RuntimeAvailability];
		if (isAvailable && IMPLEMENTED_RUNTIMES.has(name)) {
			result.push(entry);
		}
	}

	return result;
}

export const E2E_TIMEOUTS = {
	fake: { operation: 2_000, connect: 1_000 },
	docker: { operation: 30_000, connect: 10_000 },
	firecracker: { operation: 60_000, connect: 15_000 },
} as const;
