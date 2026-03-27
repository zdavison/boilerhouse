import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, afterEach } from "bun:test";
import { configFromEnv, bootstrap } from "./bootstrap";
import type { AppContext, BootstrapConfig } from "./bootstrap";

const storageDefaults: Pick<BootstrapConfig, "overlayCacheDir" | "overlayCacheMaxBytes"> = {
	overlayCacheDir: "/tmp/boilerhouse-test-cache-overlays",
	overlayCacheMaxBytes: 1024 * 1024 * 100,
};

// ── configFromEnv ───────────────────────────────────────────────────────────

describe("configFromEnv", () => {
	const savedEnv: Record<string, string | undefined> = {};

	function setEnv(vars: Record<string, string>) {
		for (const [key, value] of Object.entries(vars)) {
			savedEnv[key] = process.env[key];
			process.env[key] = value;
		}
	}

	afterEach(() => {
		for (const [key, value] of Object.entries(savedEnv)) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
		// Clear for next test
		for (const key of Object.keys(savedEnv)) delete savedEnv[key];
	});

	test("returns defaults when no env vars are set", () => {
		// Clear any env vars that might be set in the test runner
		const keys = [
			"PORT", "LISTEN_HOST", "DB_PATH", "STORAGE_PATH",
			"RUNTIME_TYPE", "MAX_INSTANCES", "WORKLOADS_DIR",
			"BOILERHOUSE_API_KEY", "BOILERHOUSE_SECRET_KEY",
			"METRICS_PORT", "METRICS_HOST",
		];
		for (const key of keys) {
			savedEnv[key] = process.env[key];
			delete process.env[key];
		}

		const config = configFromEnv();

		expect(config.port).toBe(3000);
		expect(config.listenHost).toBe("127.0.0.1");
		expect(config.dbPath).toBe("boilerhouse.db");
		expect(config.storagePath).toBe("./data");
		expect(config.runtimeType).toBe("docker");
		expect(config.maxInstances).toBe(100);
		expect(config.workloadsDir).toBeUndefined();
		expect(config.apiKey).toBeUndefined();
		expect(config.secretKey).toBeUndefined();
		expect(config.metricsPort).toBe(9464);
		expect(config.metricsHost).toBe("127.0.0.1");
	});

	test("reads values from process.env when set", () => {
		setEnv({
			PORT: "8080",
			LISTEN_HOST: "0.0.0.0",
			DB_PATH: "/tmp/test.db",
			STORAGE_PATH: "/tmp/storage",
			RUNTIME_TYPE: "fake",
			MAX_INSTANCES: "50",
			WORKLOADS_DIR: "/workloads",
			BOILERHOUSE_API_KEY: "my-api-key",
			BOILERHOUSE_SECRET_KEY: "aa".repeat(32),
			METRICS_PORT: "9999",
			METRICS_HOST: "0.0.0.0",
		});

		const config = configFromEnv();

		expect(config.port).toBe(8080);
		expect(config.listenHost).toBe("0.0.0.0");
		expect(config.dbPath).toBe("/tmp/test.db");
		expect(config.storagePath).toBe("/tmp/storage");
		expect(config.runtimeType).toBe("fake");
		expect(config.maxInstances).toBe(50);
		expect(config.workloadsDir).toBe("/workloads");
		expect(config.apiKey).toBe("my-api-key");
		expect(config.secretKey).toBe("aa".repeat(32));
		expect(config.metricsPort).toBe(9999);
		expect(config.metricsHost).toBe("0.0.0.0");
	});

	test("apiKey is undefined when BOILERHOUSE_API_KEY is empty string", () => {
		setEnv({ BOILERHOUSE_API_KEY: "" });
		const config = configFromEnv();
		expect(config.apiKey).toBeUndefined();
	});
});

// ── bootstrap ───────────────────────────────────────────────────────────────

describe("bootstrap", () => {
	let tmpDir: string;
	let ctx: AppContext | undefined;

	afterEach(() => {
		ctx = undefined;
		if (tmpDir) {
			rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	test("returns a fully-wired AppContext with fake runtime", async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "boilerhouse-bootstrap-test-"));
		const dbPath = join(tmpDir, "test.db");
		const storagePath = join(tmpDir, "storage");

		ctx = await bootstrap({
			port: 0,
			listenHost: "127.0.0.1",
			dbPath,
			storagePath,
			runtimeType: "fake",
			maxInstances: 10,
			secretKey: "a".repeat(64),
			metricsPort: 0,
			metricsHost: "127.0.0.1",
			...storageDefaults,
		});

		// All required fields of AppContext are present and defined
		expect(ctx.app).toBeDefined();
		expect(ctx.db).toBeDefined();
		expect(ctx.runtime).toBeDefined();
		expect(ctx.nodeId).toBeDefined();
		expect(ctx.eventBus).toBeDefined();
		expect(ctx.instanceManager).toBeDefined();
		expect(ctx.tenantManager).toBeDefined();
		expect(ctx.poolManager).toBeDefined();
		expect(ctx.idleMonitor).toBeDefined();
		expect(ctx.config).toBeDefined();

		// nodeId is a non-empty string
		expect(typeof ctx.nodeId).toBe("string");
		expect(ctx.nodeId.length).toBeGreaterThan(0);

		// config is passed through
		expect(ctx.config.runtimeType).toBe("fake");
		expect(ctx.config.maxInstances).toBe(10);
		expect(ctx.config.dbPath).toBe(dbPath);
	});

	test("works without secretKey when NODE_ENV is test", async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "boilerhouse-bootstrap-test-"));
		const dbPath = join(tmpDir, "test.db");
		const storagePath = join(tmpDir, "storage");

		// NODE_ENV should already be "test" in bun test, but ensure it
		const prevNodeEnv = process.env.NODE_ENV;
		process.env.NODE_ENV = "test";

		try {
			ctx = await bootstrap({
				port: 0,
				listenHost: "127.0.0.1",
				dbPath,
				storagePath,
				runtimeType: "fake",
				maxInstances: 5,
				metricsPort: 0,
				metricsHost: "127.0.0.1",
				...storageDefaults,
			});

			expect(ctx.app).toBeDefined();
			expect(ctx.db).toBeDefined();
			expect(ctx.runtime).toBeDefined();
		} finally {
			if (prevNodeEnv === undefined) {
				delete process.env.NODE_ENV;
			} else {
				process.env.NODE_ENV = prevNodeEnv;
			}
		}
	});

	test("reuses existing nodeId from the database on second bootstrap", async () => {
		tmpDir = mkdtempSync(join(tmpdir(), "boilerhouse-bootstrap-test-"));
		const dbPath = join(tmpDir, "test.db");
		const storagePath = join(tmpDir, "storage");

		const config = {
			port: 0,
			listenHost: "127.0.0.1",
			dbPath,
			storagePath,
			runtimeType: "fake" as const,
			maxInstances: 10,
			secretKey: "a".repeat(64),
			metricsPort: 0,
			metricsHost: "127.0.0.1",
			...storageDefaults,
		};

		const first = await bootstrap(config);
		const firstNodeId = first.nodeId;

		// Bootstrap again with the same DB file
		const second = await bootstrap(config);
		ctx = second;

		expect(second.nodeId).toBe(firstNodeId);
	});
});
