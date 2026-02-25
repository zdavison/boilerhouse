import { describe, test, expect, afterEach } from "bun:test";
import * as http from "node:http";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PodmanClient } from "./client";
import { PodmanRuntimeError } from "./errors";

/**
 * Creates a mock HTTP server on a temporary Unix socket.
 * The handler receives requests and returns responses for testing.
 */
function createMockServer(
	handler: (
		req: http.IncomingMessage,
		body: Buffer,
	) => { status: number; body?: unknown; rawBody?: Buffer },
): { socketPath: string; server: http.Server; close: () => Promise<void> } {
	const tmpDir = mkdtempSync(join(tmpdir(), "podman-client-test-"));
	const socketPath = join(tmpDir, "test.sock");

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

describe("PodmanClient", () => {
	let mockServer: ReturnType<typeof createMockServer>;
	let client: PodmanClient;

	afterEach(async () => {
		if (mockServer) {
			await mockServer.close();
		}
	});

	function setupMock(
		handler: (
			req: http.IncomingMessage,
			body: Buffer,
		) => { status: number; body?: unknown; rawBody?: Buffer },
	): void {
		mockServer = createMockServer(handler);
		client = new PodmanClient({
			socketPath: mockServer.socketPath,
			apiVersion: "5.0.0",
		});
	}

	test("info() parses podman info response", async () => {
		setupMock((req) => {
			expect(req.url).toBe("/v5.0.0/libpod/info");
			expect(req.method).toBe("GET");
			return {
				status: 200,
				body: {
					host: {
						criuEnabled: true,
						criuVersion: "3.19",
					},
					version: {
						Version: "5.4.2",
					},
				},
			};
		});

		const info = await client.info();
		expect(info.host.criuEnabled).toBe(true);
		expect(info.host.criuVersion).toBe("3.19");
		expect(info.version.Version).toBe("5.4.2");
	});

	test("info() returns criuEnabled=false when CRIU is not available", async () => {
		setupMock(() => ({
			status: 200,
			body: {
				host: { criuEnabled: false, criuVersion: "" },
				version: { Version: "5.4.2" },
			},
		}));

		const info = await client.info();
		expect(info.host.criuEnabled).toBe(false);
	});

	test("imageExists() returns true on 204", async () => {
		setupMock((req) => {
			expect(req.url).toContain("/libpod/images/");
			expect(req.url).toContain("/exists");
			return { status: 204 };
		});

		const exists = await client.imageExists("alpine:3.21");
		expect(exists).toBe(true);
	});

	test("imageExists() returns false on 404", async () => {
		setupMock(() => ({ status: 404, body: { cause: "not found" } }));

		const exists = await client.imageExists("nonexistent:latest");
		expect(exists).toBe(false);
	});

	test("pullImage() sends POST with encoded reference", async () => {
		setupMock((req) => {
			expect(req.method).toBe("POST");
			expect(req.url).toContain("/libpod/images/pull");
			expect(req.url).toContain("reference=");
			return { status: 200, body: { id: "sha256:abc123" } };
		});

		await client.pullImage("docker.io/library/alpine:3.21");
	});

	test("pullImage() throws on non-200", async () => {
		setupMock(() => ({
			status: 500,
			body: { message: "internal error" },
		}));

		await expect(
			client.pullImage("bad-image:latest"),
		).rejects.toThrow(PodmanRuntimeError);
	});

	test("createContainer() sends correct JSON body and returns ID", async () => {
		let receivedBody: Record<string, unknown> | undefined;

		setupMock((req, body) => {
			expect(req.method).toBe("POST");
			expect(req.url).toContain("/libpod/containers/create");
			receivedBody = JSON.parse(body.toString());
			return { status: 201, body: { Id: "abc123def456" } };
		});

		const id = await client.createContainer({
			name: "test-container",
			image: "alpine:3.21",
			command: ["-c", "sleep infinity"],
			entrypoint: ["/bin/sh"],
			env: { FOO: "bar" },
			work_dir: "/app",
			resource_limits: {
				cpu: { quota: 100000, period: 100000 },
				memory: { limit: 134217728 },
			},
			portmappings: [
				{ container_port: 8080, host_port: 0, protocol: "tcp" },
			],
		});

		expect(id).toBe("abc123def456");
		expect(receivedBody?.name).toBe("test-container");
		expect(receivedBody?.image).toBe("alpine:3.21");
		expect(receivedBody?.command).toEqual(["-c", "sleep infinity"]);
		expect(receivedBody?.entrypoint).toEqual(["/bin/sh"]);
		expect(receivedBody?.env).toEqual({ FOO: "bar" });
		expect(receivedBody?.work_dir).toBe("/app");
	});

	test("createContainer() throws on non-201", async () => {
		setupMock(() => ({
			status: 409,
			body: { message: "container name already in use" },
		}));

		await expect(
			client.createContainer({ name: "dup", image: "alpine:3.21" }),
		).rejects.toThrow("container name already in use");
	});

	test("startContainer() accepts 204 (started)", async () => {
		setupMock((req) => {
			expect(req.method).toBe("POST");
			expect(req.url).toContain("/start");
			return { status: 204 };
		});

		await client.startContainer("test-id");
	});

	test("startContainer() accepts 304 (already running)", async () => {
		setupMock(() => ({ status: 304 }));
		await client.startContainer("test-id");
	});

	test("startContainer() throws on error", async () => {
		setupMock(() => ({
			status: 500,
			body: { message: "container not found" },
		}));

		await expect(client.startContainer("bad-id")).rejects.toThrow(
			PodmanRuntimeError,
		);
	});

	test("removeContainer() accepts 200 (removed)", async () => {
		setupMock((req) => {
			expect(req.method).toBe("DELETE");
			expect(req.url).toContain("force=true");
			return {
				status: 200,
				body: [{ Id: "abc123", Err: null }],
			};
		});

		await client.removeContainer("test-id");
	});

	test("removeContainer() accepts 404 (already gone)", async () => {
		setupMock(() => ({ status: 404 }));
		await client.removeContainer("test-id");
	});

	test("inspectContainer() returns parsed container data", async () => {
		setupMock((req) => {
			expect(req.method).toBe("GET");
			expect(req.url).toContain("/json");
			return {
				status: 200,
				body: {
					Id: "abc123",
					State: { Running: true, Status: "running" },
					NetworkSettings: {
						Ports: {
							"8080/tcp": [{ HostIp: "0.0.0.0", HostPort: "32768" }],
						},
					},
				},
			};
		});

		const inspect = await client.inspectContainer("abc123");
		expect(inspect.State.Running).toBe(true);
		expect(inspect.NetworkSettings.Ports["8080/tcp"]![0]!.HostPort).toBe("32768");
	});

	test("checkpointContainer() returns archive buffer", async () => {
		const fakeArchive = Buffer.from("fake-checkpoint-data");

		setupMock((req) => {
			expect(req.method).toBe("POST");
			expect(req.url).toContain("/checkpoint");
			expect(req.url).toContain("export=true");
			expect(req.url).toContain("leaveRunning=false");
			return { status: 200, rawBody: fakeArchive };
		});

		const result = await client.checkpointContainer("test-id");
		expect(Buffer.isBuffer(result)).toBe(true);
		expect(result.toString()).toBe("fake-checkpoint-data");
	});

	test("restoreContainer() sends archive and returns ID", async () => {
		const fakeArchive = Buffer.from("fake-archive-data");
		let receivedBody: Buffer | undefined;

		setupMock((req, body) => {
			expect(req.method).toBe("POST");
			expect(req.url).toContain("/restore");
			expect(req.url).toContain("import=true");
			expect(req.url).toContain("name=");
			expect(req.headers["content-type"]).toBe("application/x-tar");
			receivedBody = body;
			return { status: 200, body: { Id: "restored-123" } };
		});

		const id = await client.restoreContainer(fakeArchive, "new-container");
		expect(id).toBe("restored-123");
		expect(receivedBody?.toString()).toBe("fake-archive-data");
	});

	test("restoreContainer() throws on failure", async () => {
		setupMock(() => ({
			status: 500,
			body: { message: "restore failed: CRIU error" },
		}));

		await expect(
			client.restoreContainer(Buffer.from("bad"), "test"),
		).rejects.toThrow("restore failed");
	});

	test("execCreate() returns exec session ID", async () => {
		setupMock((req, body) => {
			expect(req.method).toBe("POST");
			expect(req.url).toContain("/exec");
			const parsed = JSON.parse(body.toString());
			expect(parsed.Cmd).toEqual(["echo", "hello"]);
			expect(parsed.AttachStdout).toBe(true);
			expect(parsed.AttachStderr).toBe(true);
			return { status: 201, body: { Id: "exec-session-123" } };
		});

		const id = await client.execCreate("container-id", ["echo", "hello"]);
		expect(id).toBe("exec-session-123");
	});

	test("connection error throws PodmanRuntimeError", async () => {
		const badClient = new PodmanClient({
			socketPath: "/nonexistent/path/to/socket.sock",
		});

		await expect(badClient.info()).rejects.toThrow(PodmanRuntimeError);
	});

	test("get() sends correct method and path", async () => {
		setupMock((req) => {
			expect(req.method).toBe("GET");
			expect(req.url).toBe("/v5.0.0/libpod/test");
			return { status: 200, body: { ok: true } };
		});

		const res = await client.get("/libpod/test");
		expect(res.status).toBe(200);
		expect((res.body as Record<string, unknown>).ok).toBe(true);
	});

	test("del() sends DELETE method", async () => {
		setupMock((req) => {
			expect(req.method).toBe("DELETE");
			return { status: 200, body: {} };
		});

		const res = await client.del("/libpod/containers/test");
		expect(res.status).toBe(200);
	});

	test("custom apiVersion is used in URL path", async () => {
		mockServer = createMockServer((req) => {
			expect(req.url).toStartWith("/v4.0.0/");
			return { status: 200, body: {} };
		});
		const customClient = new PodmanClient({
			socketPath: mockServer.socketPath,
			apiVersion: "4.0.0",
		});

		await customClient.get("/libpod/info");
	});
});
