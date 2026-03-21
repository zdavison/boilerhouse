import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import * as http from "node:http";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemon } from "./main";

/** Base security fields required by validation policy. */
const HARDENED = {
	cap_drop: ["ALL"],
	cap_add: ["CAP_CHOWN", "CAP_NET_BIND_SERVICE"],
	no_new_privileges: true,
} as const;

/**
 * Creates a mock Podman API server on a temp Unix socket.
 * Tracks requests for assertion.
 */
function createMockPodman(
	handler: (
		req: http.IncomingMessage,
		body: Buffer,
	) => { status: number; body?: unknown; rawBody?: Buffer },
): { socketPath: string; server: http.Server; close: () => Promise<void> } {
	const tmpDir = mkdtempSync(join(tmpdir(), "boilerhouse-podmand-test-podman-"));
	const socketPath = join(tmpDir, "podman.sock");

	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const body = Buffer.concat(chunks);
			const response = handler(req, body);

			res.writeHead(response.status, {
				"Content-Type": "application/json",
			});

			if (response.rawBody) {
				res.end(response.rawBody);
			} else if (response.body !== undefined) {
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

/** HTTP client that talks to a Unix socket. */
async function request(
	socketPath: string,
	method: string,
	path: string,
	body?: unknown,
): Promise<{ status: number; body: unknown }> {
	return new Promise((resolve, reject) => {
		const bodyData = body ? Buffer.from(JSON.stringify(body)) : undefined;
		const headers: Record<string, string> = {};
		if (bodyData) {
			headers["Content-Type"] = "application/json";
			headers["Content-Length"] = String(bodyData.length);
		}

		const req = http.request(
			{ socketPath, path, method, headers },
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () => {
					const raw = Buffer.concat(chunks).toString("utf-8");
					let parsed: unknown;
					try {
						parsed = raw ? JSON.parse(raw) : null;
					} catch {
						parsed = raw;
					}
					resolve({ status: res.statusCode ?? 0, body: parsed });
				});
				res.on("error", reject);
			},
		);
		req.on("error", reject);
		if (bodyData) req.write(bodyData);
		req.end();
	});
}

describe("boilerhouse-podmand", () => {
	let mockPodman: ReturnType<typeof createMockPodman>;
	let daemonSocketPath: string;
	let daemonTmpDir: string;
	let stopDaemon: () => void;
	const createdContainers: string[] = [];

	beforeAll(async () => {
		// Track which containers mock podman knows about
		let containerCounter = 0;

		mockPodman = createMockPodman((req, _body) => {
			const url = req.url ?? "";

			// Recovery — list managed containers
			if (req.method === "GET" && url.includes("/libpod/containers/json")) {
				return { status: 200, body: [] };
			}

			// Info
			if (url.includes("/libpod/info")) {
				return {
					status: 200,
					body: {
						host: { criuEnabled: true, criuVersion: "4.2" },
						version: { Version: "5.4.2" },
					},
				};
			}

			// Image exists
			if (url.includes("/images/") && url.includes("/exists")) {
				return { status: 204 };
			}

			// Image pull
			if (url.includes("/images/pull")) {
				return { status: 200, body: { id: "sha256:abc" } };
			}

			// Container create
			if (req.method === "POST" && url.includes("/libpod/containers/create")) {
				containerCounter++;
				const id = `ctr-${containerCounter}`;
				createdContainers.push(id);
				return { status: 201, body: { Id: id } };
			}

			// Container start
			if (req.method === "POST" && url.includes("/start")) {
				return { status: 204 };
			}

			// Container inspect
			if (req.method === "GET" && url.includes("/json") && url.includes("/libpod/containers/")) {
				// Extract container ID from URL and check if it's known
				const ctrMatch = url.match(/\/libpod\/containers\/([^/?]+)\/json/);
				const ctrId = ctrMatch?.[1];
				if (ctrId && !createdContainers.includes(ctrId)) {
					return { status: 404, body: { cause: "no such container", message: `no container with name or ID "${ctrId}" found`, response: 404 } };
				}
				return {
					status: 200,
					body: {
						Id: ctrId ?? "ctr-1",
						State: { Running: true, Status: "running" },
						NetworkSettings: { Ports: {} },
					},
				};
			}

			// Container remove
			if (req.method === "DELETE" && url.includes("/libpod/containers/")) {
				const ctrMatch = url.match(/\/libpod\/containers\/([^/?]+)/);
				const ctrId = ctrMatch?.[1];
				if (ctrId && !createdContainers.includes(ctrId)) {
					return { status: 404, body: { cause: "no such container", message: `no container with name or ID "${ctrId}" found`, response: 404 } };
				}
				// Remove from tracked containers (mirrors real podman behavior)
				if (ctrId) {
					const idx = createdContainers.indexOf(ctrId);
					if (idx !== -1) createdContainers.splice(idx, 1);
				}
				return { status: 200, body: [{ Id: ctrId ?? "ctr-1", Err: null }] };
			}

			// Exec create
			if (req.method === "POST" && url.includes("/exec") && !url.includes("/start")) {
				return { status: 201, body: { Id: "exec-1" } };
			}

			// Exec start
			if (req.method === "POST" && url.includes("/exec/") && url.includes("/start")) {
				return { status: 200, rawBody: Buffer.alloc(0) };
			}

			// Exec inspect
			if (req.method === "GET" && url.includes("/exec/") && url.includes("/json")) {
				return { status: 200, body: { ExitCode: 0 } };
			}

			return { status: 404, body: { message: `unhandled: ${req.method} ${url}` } };
		});

		daemonTmpDir = mkdtempSync(join(tmpdir(), "boilerhouse-podmand-test-"));
		daemonSocketPath = join(daemonTmpDir, "runtime.sock");

		const daemon = await createDaemon({
			podmanSocketPath: mockPodman.socketPath,
			listenSocketPath: daemonSocketPath,
			snapshotDir: join(daemonTmpDir, "snapshots"),
			managePodman: false,
		});
		stopDaemon = daemon.stop;
	});

	afterAll(async () => {
		stopDaemon?.();
		await mockPodman?.close();
		if (existsSync(daemonTmpDir)) {
			rmSync(daemonTmpDir, { recursive: true, force: true });
		}
	});

	test("GET /healthz returns 200", async () => {
		const res = await request(daemonSocketPath, "GET", "/healthz");
		expect(res.status).toBe(200);
	});

	test("GET /info returns system info", async () => {
		const res = await request(daemonSocketPath, "GET", "/info");
		expect(res.status).toBe(200);
		const info = res.body as Record<string, unknown>;
		expect(info.criuEnabled).toBe(true);
		expect(info.version).toBe("5.4.2");
		expect(typeof info.architecture).toBe("string");
	});

	test("POST /images/ensure with ref returns image ref", async () => {
		const res = await request(daemonSocketPath, "POST", "/images/ensure", {
			ref: "alpine:3.21",
		});
		expect(res.status).toBe(200);
		expect((res.body as Record<string, unknown>).image).toBe("alpine:3.21");
	});

	test("POST /containers creates a container and registers it", async () => {
		const spec = {
			name: "test-ctr-1",
			image: "alpine:3.21",
			portmappings: [{ container_port: 8080, host_port: 0, protocol: "tcp" }],
			...HARDENED,
		};
		const res = await request(daemonSocketPath, "POST", "/containers", { spec });
		expect(res.status).toBe(201);
		const body = res.body as Record<string, unknown>;
		expect(typeof body.id).toBe("string");
	});

	test("POST /containers rejects privileged spec", async () => {
		const spec = {
			name: "evil-ctr",
			image: "alpine:3.21",
			privileged: true,
			...HARDENED,
		};
		const res = await request(daemonSocketPath, "POST", "/containers", { spec });
		expect(res.status).toBe(403);
	});

	test("POST /containers rejects fixed host port", async () => {
		const spec = {
			name: "evil-port",
			image: "alpine:3.21",
			portmappings: [{ container_port: 80, host_port: 80, protocol: "tcp" }],
			...HARDENED,
		};
		const res = await request(daemonSocketPath, "POST", "/containers", { spec });
		expect(res.status).toBe(403);
	});

	test("POST /containers rejects host network namespace", async () => {
		const spec = {
			name: "evil-netns",
			image: "alpine:3.21",
			netns: { nsmode: "host" },
			...HARDENED,
		};
		const res = await request(daemonSocketPath, "POST", "/containers", { spec });
		expect(res.status).toBe(403);
	});

	test("POST /containers rejects bind mounts", async () => {
		const spec = {
			name: "evil-bind",
			image: "alpine:3.21",
			...HARDENED,
			mounts: [{ destination: "/host", type: "bind", options: [] }],
		};
		const res = await request(daemonSocketPath, "POST", "/containers", { spec });
		expect(res.status).toBe(403);
	});

	test("POST /containers/:id/start starts a registered container", async () => {
		// First create a container
		const createRes = await request(daemonSocketPath, "POST", "/containers", {
			spec: { name: "start-test", image: "alpine:3.21", ...HARDENED },
		});
		const { id } = createRes.body as { id: string };

		const res = await request(daemonSocketPath, "POST", `/containers/${id}/start`);
		expect(res.status).toBe(204);
	});

	test("POST /containers/:id/start rejects unknown container", async () => {
		const res = await request(daemonSocketPath, "POST", "/containers/unknown-id/start");
		expect(res.status).toBe(404);
	});

	test("GET /containers/:id inspects a registered container", async () => {
		// Create a container first
		const createRes = await request(daemonSocketPath, "POST", "/containers", {
			spec: { name: "inspect-test", image: "alpine:3.21", ...HARDENED },
		});
		const { id } = createRes.body as { id: string };

		const res = await request(daemonSocketPath, "GET", `/containers/${id}`);
		expect(res.status).toBe(200);
	});

	test("GET /containers/:id rejects unknown container", async () => {
		const res = await request(daemonSocketPath, "GET", "/containers/unknown-id");
		expect(res.status).toBe(404);
	});

	test("DELETE /containers/:id removes a registered container", async () => {
		const createRes = await request(daemonSocketPath, "POST", "/containers", {
			spec: { name: "delete-test", image: "alpine:3.21", ...HARDENED },
		});
		const { id } = createRes.body as { id: string };

		const res = await request(daemonSocketPath, "DELETE", `/containers/${id}`);
		expect(res.status).toBe(204);

		// Should be gone from registry now
		const res2 = await request(daemonSocketPath, "GET", `/containers/${id}`);
		expect(res2.status).toBe(404);
	});

	test("DELETE /containers/:id is idempotent for unknown container", async () => {
		const res = await request(daemonSocketPath, "DELETE", "/containers/unknown-id");
		expect(res.status).toBe(204);
	});

	test("POST /containers/:id/exec runs a command in a registered container", async () => {
		const createRes = await request(daemonSocketPath, "POST", "/containers", {
			spec: { name: "exec-test", image: "alpine:3.21", ...HARDENED },
		});
		const { id } = createRes.body as { id: string };

		const res = await request(daemonSocketPath, "POST", `/containers/${id}/exec`, {
			cmd: ["echo", "hello"],
		});
		expect(res.status).toBe(200);
		const body = res.body as Record<string, unknown>;
		expect(typeof body.exitCode).toBe("number");
	});

	test("POST /containers/:id/exec rejects unknown container", async () => {
		const res = await request(daemonSocketPath, "POST", "/containers/unknown-id/exec", {
			cmd: ["echo", "hello"],
		});
		expect(res.status).toBe(404);
	});

	test("GET /containers lists registered containers by name", async () => {
		const res = await request(daemonSocketPath, "GET", "/containers");
		expect(res.status).toBe(200);
		const body = res.body as { ids: string[] };
		expect(Array.isArray(body.ids)).toBe(true);
		// Listed IDs should be container names, not podman hex IDs
		for (const id of body.ids) {
			expect(id).not.toMatch(/^ctr-/);
		}
	});

	test("containers are addressable by name (not just podman ID)", async () => {
		const name = "name-lookup-test";
		const createRes = await request(daemonSocketPath, "POST", "/containers", {
			spec: { name, image: "alpine:3.21", ...HARDENED },
		});
		expect(createRes.status).toBe(201);

		// Start using the container name (how PodmanRuntime calls the daemon)
		const startRes = await request(daemonSocketPath, "POST", `/containers/${name}/start`);
		expect(startRes.status).toBe(204);

		// Inspect by name
		const inspectRes = await request(daemonSocketPath, "GET", `/containers/${name}`);
		expect(inspectRes.status).toBe(200);

		// Exec by name
		const execRes = await request(daemonSocketPath, "POST", `/containers/${name}/exec`, {
			cmd: ["echo", "hello"],
		});
		expect(execRes.status).toBe(200);

		// Remove by name
		const removeRes = await request(daemonSocketPath, "DELETE", `/containers/${name}`);
		expect(removeRes.status).toBe(204);

		// Should be gone
		const res2 = await request(daemonSocketPath, "GET", `/containers/${name}`);
		expect(res2.status).toBe(404);
	});
});
