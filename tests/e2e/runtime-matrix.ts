import { resolve, dirname } from "node:path";
import { detectRuntimes, type RuntimeAvailability } from "./runtime-detect";

/**
 * Named workload fixtures matching the dev workloads:
 * minimal, httpserver, openclaw.
 */
export interface WorkloadFixtures {
	/** No network, no ports, no health check. */
	minimal: string;
	/** HTTP server on port 8080, outbound network, HTTP health check. */
	httpserver: string;
	/** Restricted network with allowlist, port 18789, HTTP health check. */
	openclaw: string;
	/** WebSocket echo server on port 8080, outbound network, HTTP health check, websocket on /ws. */
	wsecho: string;
}

export interface RuntimeEntry {
	name: string;
	capabilities: {
		/** CRIU-based golden snapshots for instant cold starts. */
		goldenSnapshot: boolean;
		/** Hibernate: overlay data extracted from containers survives release/re-claim. */
		tenantSnapshot: boolean;
		exec: boolean;
		networking: boolean;
		/**
		 * Whether concurrent snapshot restores from the same golden are
		 * supported.
		 * @default true
		 */
		concurrentRestore: boolean;
	};
	/** Workload fixture paths for this runtime, keyed by workload name. */
	workloadFixtures: WorkloadFixtures;
	/**
	 * Workload fixture that will fail during instance creation.
	 * Used by error-recovery tests. Mechanism is runtime-specific:
	 * - fake: server started with failOn config
	 * - docker: workload references a nonexistent image
	 * - podman: workload references a nonexistent image
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
		goldenSnapshot: true,
		tenantSnapshot: true,

		exec: true,
		networking: false,
		concurrentRestore: true,
	},
	workloadFixtures: {
		minimal: fixturePath("workload-fake-minimal.workload.ts"),
		httpserver: fixturePath("workload-fake-httpserver.workload.ts"),
		openclaw: fixturePath("workload-fake-openclaw.workload.ts"),
		wsecho: fixturePath("workload-fake-wsecho.workload.ts"),
	},
	brokenWorkloadFixture: fixturePath("workload-fake-broken.workload.ts"),
	verifyCleanup: async () => {
		// No-op for fake runtime
	},
	isInstanceRunning: async () => false,
};

const dockerEntry: RuntimeEntry = {
	name: "docker",
	capabilities: {
		goldenSnapshot: false,
		tenantSnapshot: true,

		exec: true,
		networking: true,
		concurrentRestore: true,
	},
	workloadFixtures: {
		minimal: fixturePath("workload-docker-minimal.workload.ts"),
		httpserver: fixturePath("workload-docker-httpserver.workload.ts"),
		openclaw: fixturePath("workload-docker.workload.ts"),
		wsecho: fixturePath("workload-docker-wsecho.workload.ts"),
	},
	brokenWorkloadFixture: fixturePath("workload-docker-broken.workload.ts"),
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

const kubernetesEntry: RuntimeEntry = {
	name: "kubernetes",
	capabilities: {
		goldenSnapshot: false,
		tenantSnapshot: true,

		exec: true,
		networking: true,
		concurrentRestore: false,
	},
	workloadFixtures: {
		minimal: fixturePath("workload-k8s-minimal.workload.ts"),
		httpserver: fixturePath("workload-k8s-httpserver.workload.ts"),
		openclaw: fixturePath("workload-k8s-openclaw.workload.ts"),
		wsecho: fixturePath("workload-k8s-wsecho.workload.ts"),
	},
	brokenWorkloadFixture: fixturePath("workload-k8s-broken.workload.ts"),
	verifyCleanup: async () => {
		const result = Bun.spawnSync([
			"kubectl", "--context", "boilerhouse-test",
			"-n", "boilerhouse",
			"get", "pods",
			"-l", "boilerhouse.dev/managed=true",
			"-o", "name",
		]);
		const output = result.stdout.toString().trim();
		if (output.length > 0) {
			throw new Error(`Orphaned K8s pods found: ${output}`);
		}
	},
	isInstanceRunning: async (instanceId: string) => {
		const result = Bun.spawnSync([
			"kubectl", "--context", "boilerhouse-test",
			"-n", "boilerhouse",
			"get", "pod", instanceId,
			"-o", "jsonpath={.status.phase}",
		]);
		return result.stdout.toString().trim() === "Running";
	},
};

const ALL_ENTRIES: Record<string, RuntimeEntry> = {
	fake: fakeEntry,
	docker: dockerEntry,
	kubernetes: kubernetesEntry,
};

/**
 * Runtimes that have a working Runtime implementation wired into startE2EServer.
 */
const IMPLEMENTED_RUNTIMES = new Set(["fake", "docker", "kubernetes"]);

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
	kubernetes: { operation: 120_000, connect: 10_000 },
} as const;
