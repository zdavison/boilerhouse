import { describe, test, expect, afterEach } from "bun:test";
import * as http from "node:http";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateInstanceId } from "@boilerhouse/core";
import type { Workload } from "@boilerhouse/core";
import { PodmanRuntime, hasEstablishedConnections } from "./runtime";
import { resolveTemplates } from "./templates";
import type { ContainerCreateSpec } from "./client";

/**
 * Creates a mock HTTP server on a temporary Unix socket that speaks
 * the boilerhouse-podmand daemon API.
 */
function createMockDaemon(
	handler: (
		method: string,
		url: string,
		body: unknown,
	) => { status: number; body?: unknown },
): { socketPath: string; server: http.Server; close: () => Promise<void> } {
	const tmpDir = mkdtempSync(join(tmpdir(), "podman-runtime-test-"));
	const socketPath = join(tmpDir, "test.sock");

	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const raw = Buffer.concat(chunks).toString("utf-8");
			const parsed = raw ? JSON.parse(raw) : null;
			const response = handler(req.method ?? "GET", req.url ?? "/", parsed);

			res.writeHead(response.status, {
				"Content-Type": "application/json",
			});

			if (response.body !== undefined) {
				res.end(JSON.stringify(response.body));
			} else {
				res.end();
			}
		});
	});

	server.listen(socketPath);

	return {
		socketPath,
		server,
		close: () =>
			new Promise<void>((resolve) => {
				server.close(() => {
					if (existsSync(tmpDir)) {
						rmSync(tmpDir, { recursive: true, force: true });
					}
					resolve();
				});
			}),
	};
}

describe("PodmanRuntime", () => {
	let mockServer: ReturnType<typeof createMockDaemon>;

	afterEach(async () => {
		if (mockServer) {
			await mockServer.close();
		}
	});

	const BASE_WORKLOAD: Workload = {
		workload: { name: "test-app", version: "1.0.0" },
		image: { ref: "alpine:3.21" },
		resources: { vcpus: 1, memory_mb: 128, disk_gb: 1 },
		network: { access: "none" },
		idle: { action: "hibernate" },
	};

	/**
	 * Creates a mock daemon that captures the container create spec
	 * and stores it in the returned ref for assertion.
	 */
	function createSpecCapturingDaemon(): {
		mock: ReturnType<typeof createMockDaemon>;
		captured: { spec: ContainerCreateSpec | undefined; podSpec: Record<string, unknown> | undefined };
	} {
		const captured: { spec: ContainerCreateSpec | undefined; podSpec: Record<string, unknown> | undefined } = { spec: undefined, podSpec: undefined };

		const mock = createMockDaemon((method, url, body) => {
			// POST /images/ensure
			if (method === "POST" && url === "/images/ensure") {
				const b = body as { ref?: string };
				return { status: 200, body: { image: b.ref ?? "built:latest" } };
			}
			// POST /pods (create)
			if (method === "POST" && url === "/pods") {
				captured.podSpec = body as Record<string, unknown>;
				return { status: 201, body: { id: "pod-mock" } };
			}
			// POST /containers (create) — capture the workload container spec
			if (method === "POST" && url === "/containers") {
				const b = body as { spec: ContainerCreateSpec };
				// Only capture the workload container, not the proxy sidecar
				if (!b.spec.name.endsWith("-proxy")) {
					captured.spec = b.spec;
				}
				return { status: 201, body: { id: "ctr-mock" } };
			}
			// POST /files (write proxy config)
			if (method === "POST" && url === "/files") {
				return { status: 200, body: { path: "/tmp/mock-envoy.yaml" } };
			}
			return { status: 404, body: { error: "not found" } };
		});

		return { mock, captured };
	}

	test("create() converts overlay_dirs to tmpfs mounts", async () => {
		const { mock, captured } = createSpecCapturingDaemon();
		mockServer = mock;

		const snapshotDir = mkdtempSync(join(tmpdir(), "bh-snap-"));
		const runtime = new PodmanRuntime({
			snapshotDir,
			socketPath: mock.socketPath,
		});

		const workload: Workload = {
			...BASE_WORKLOAD,
			filesystem: {
				overlay_dirs: ["/home/node/.openclaw", "/var/data"],
			},
		};

		await runtime.create(workload, generateInstanceId());

		expect(captured.spec?.mounts).toEqual([
			{ destination: "/home/node/.openclaw", type: "tmpfs", options: ["size=256m", "mode=1777"] },
			{ destination: "/var/data", type: "tmpfs", options: ["size=256m", "mode=1777"] },
		]);

		rmSync(snapshotDir, { recursive: true, force: true });
	});

	test("create() resolves ${VAR} in entrypoint env values", async () => {
		process.env.TEST_SECRET_KEY = "sk-test-12345";
		const { mock, captured } = createSpecCapturingDaemon();
		mockServer = mock;

		const snapshotDir = mkdtempSync(join(tmpdir(), "bh-snap-"));
		const runtime = new PodmanRuntime({
			snapshotDir,
			socketPath: mock.socketPath,
		});

		const workload: Workload = {
			...BASE_WORKLOAD,
			entrypoint: {
				cmd: "node",
				args: ["server.js"],
				env: {
					API_KEY: "${TEST_SECRET_KEY}",
					FIXED_VAL: "literal",
				},
			},
		};

		await runtime.create(workload, generateInstanceId());

		expect(captured.spec?.env).toEqual({
			API_KEY: "sk-test-12345",
			FIXED_VAL: "literal",
		});

		delete process.env.TEST_SECRET_KEY;
		rmSync(snapshotDir, { recursive: true, force: true });
	});

	test("create() injects HTTP_PROXY when proxyAddress is set", async () => {
		const { mock, captured } = createSpecCapturingDaemon();
		mockServer = mock;

		const snapshotDir = mkdtempSync(join(tmpdir(), "bh-snap-"));
		const runtime = new PodmanRuntime({
			snapshotDir,
			socketPath: mock.socketPath,
		});

		const workload: Workload = {
			...BASE_WORKLOAD,
			network: { access: "outbound" },
		};

		await runtime.create(workload, generateInstanceId());

		// Without proxyConfig, no HTTP_PROXY is injected (no sidecar)
		expect(captured.spec?.env).toBeUndefined();

		rmSync(snapshotDir, { recursive: true, force: true });
	});

	test("create() emits privileged: false in the container create body", async () => {
		const { mock, captured } = createSpecCapturingDaemon();
		mockServer = mock;

		const snapshotDir = mkdtempSync(join(tmpdir(), "bh-snap-"));
		const runtime = new PodmanRuntime({
			snapshotDir,
			socketPath: mock.socketPath,
		});

		await runtime.create(BASE_WORKLOAD, generateInstanceId());

		expect(captured.spec?.privileged).toBe(false);

		rmSync(snapshotDir, { recursive: true, force: true });
	});

	test("create() always sets host_port: 0 for ephemeral allocation", async () => {
		const { mock, captured } = createSpecCapturingDaemon();
		mockServer = mock;

		const snapshotDir = mkdtempSync(join(tmpdir(), "bh-snap-"));
		const runtime = new PodmanRuntime({
			snapshotDir,
			socketPath: mock.socketPath,
		});

		const workload: Workload = {
			...BASE_WORKLOAD,
			network: {
				access: "outbound",
				expose: [{ guest: 8080, host_range: [0, 0] }, { guest: 9090, host_range: [0, 0] }],
			},
		};

		await runtime.create(workload, generateInstanceId());

		// Port mappings are on the pod, not the container
		const podPorts = captured.podSpec?.portmappings as Array<{ host_port: number }>;
		expect(podPorts).toHaveLength(2);
		for (const pm of podPorts) {
			expect(pm.host_port).toBe(0);
		}

		rmSync(snapshotDir, { recursive: true, force: true });
	});

	test("create() uses isolated network namespace (not host)", async () => {
		const { mock, captured } = createSpecCapturingDaemon();
		mockServer = mock;

		const snapshotDir = mkdtempSync(join(tmpdir(), "bh-snap-"));
		const runtime = new PodmanRuntime({
			snapshotDir,
			socketPath: mock.socketPath,
		});

		// network.access = "none" maps to nsmode: "none" (isolated)
		await runtime.create(BASE_WORKLOAD, generateInstanceId());
		expect(captured.spec?.netns?.nsmode).not.toBe("host");

		rmSync(snapshotDir, { recursive: true, force: true });
	});

	test("create() does not include mounts when no overlay_dirs", async () => {
		const { mock, captured } = createSpecCapturingDaemon();
		mockServer = mock;

		const snapshotDir = mkdtempSync(join(tmpdir(), "bh-snap-"));
		const runtime = new PodmanRuntime({
			snapshotDir,
			socketPath: mock.socketPath,
		});

		await runtime.create(BASE_WORKLOAD, generateInstanceId());

		expect(captured.spec?.mounts).toBeUndefined();

		rmSync(snapshotDir, { recursive: true, force: true });
	});
});

describe("resolveTemplates", () => {
	const originalEnv = { ...process.env };

	afterEach(() => {
		// Restore original env
		for (const key of Object.keys(process.env)) {
			if (!(key in originalEnv)) {
				delete process.env[key];
			}
		}
		Object.assign(process.env, originalEnv);
	});

	test("substitutes ${VAR} with host process.env value", () => {
		process.env.MY_SECRET = "hunter2";
		const result = resolveTemplates({ API_KEY: "${MY_SECRET}" });
		expect(result).toEqual({ API_KEY: "hunter2" });
	});

	test("replaces unset variables with empty string", () => {
		delete process.env.DOES_NOT_EXIST;
		const result = resolveTemplates({ TOKEN: "${DOES_NOT_EXIST}" });
		expect(result).toEqual({ TOKEN: "" });
	});

	test("passes through literal values unchanged", () => {
		const result = resolveTemplates({ FIXED: "some-literal-value" });
		expect(result).toEqual({ FIXED: "some-literal-value" });
	});

	test("handles mixed literal and variable values", () => {
		process.env.HOST = "localhost";
		const result = resolveTemplates({ URL: "http://${HOST}:8080/api" });
		expect(result).toEqual({ URL: "http://localhost:8080/api" });
	});

	test("handles multiple variables in same value", () => {
		process.env.USER_A = "alice";
		process.env.USER_B = "bob";
		const result = resolveTemplates({ USERS: "${USER_A},${USER_B}" });
		expect(result).toEqual({ USERS: "alice,bob" });
	});
});

describe("hasEstablishedConnections", () => {
	test("returns false for empty /proc/net/tcp (header only)", () => {
		const output =
			"  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n";
		expect(hasEstablishedConnections(output)).toBe(false);
	});

	test("returns false when only LISTEN sockets exist (state 0A)", () => {
		const output = [
			"  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
			"   0: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345 1 0000000000000000 100 0 0 10 0",
			"   1: 00000000:0050 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12346 1 0000000000000000 100 0 0 10 0",
		].join("\n");
		expect(hasEstablishedConnections(output)).toBe(false);
	});

	test("returns true when an ESTABLISHED connection exists (state 01)", () => {
		const output = [
			"  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
			"   0: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12345 1 0000000000000000 100 0 0 10 0",
			"   1: 0100007F:1F90 0100007F:C5A8 01 00000000:00000000 00:00000000 00000000     0        0 12347 1 0000000000000000 100 0 0 10 0",
		].join("\n");
		expect(hasEstablishedConnections(output)).toBe(true);
	});

	test("returns false for empty string", () => {
		expect(hasEstablishedConnections("")).toBe(false);
	});

	test("returns false for TIME_WAIT (state 06) and CLOSE_WAIT (state 08)", () => {
		const output = [
			"  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
			"   0: 0100007F:1F90 0100007F:C5A8 06 00000000:00000000 00:00000000 00000000     0        0 12345 1 0000000000000000 100 0 0 10 0",
			"   1: 0100007F:1F90 0100007F:C5A9 08 00000000:00000000 00:00000000 00000000     0        0 12346 1 0000000000000000 100 0 0 10 0",
		].join("\n");
		expect(hasEstablishedConnections(output)).toBe(false);
	});
});
