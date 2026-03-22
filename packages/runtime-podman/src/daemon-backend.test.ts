import { describe, test, expect, afterEach } from "bun:test";
import * as http from "node:http";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonBackend } from "./daemon-backend";

/**
 * Creates a mock boilerhouse-podmand daemon on a temp Unix socket.
 */
function createMockDaemon(
	handler: (
		req: http.IncomingMessage,
		body: Buffer,
	) => { status: number; body?: unknown },
): { socketPath: string; server: http.Server; close: () => Promise<void> } {
	const tmpDir = mkdtempSync(join(tmpdir(), "daemon-backend-test-"));
	const socketPath = join(tmpDir, "daemon.sock");

	const server = http.createServer((req, res) => {
		const chunks: Buffer[] = [];
		req.on("data", (chunk: Buffer) => chunks.push(chunk));
		req.on("end", () => {
			const body = Buffer.concat(chunks);
			const response = handler(req, body);

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

describe("DaemonBackend", () => {
	let mockDaemon: ReturnType<typeof createMockDaemon>;
	let backend: DaemonBackend;

	afterEach(async () => {
		if (mockDaemon) {
			await mockDaemon.close();
		}
	});

	function setup(
		handler: (
			req: http.IncomingMessage,
			body: Buffer,
		) => { status: number; body?: unknown },
	): void {
		mockDaemon = createMockDaemon(handler);
		backend = new DaemonBackend({ socketPath: mockDaemon.socketPath });
	}

	test("info() returns backend info", async () => {
		setup((req) => {
			expect(req.url).toBe("/info");
			expect(req.method).toBe("GET");
			return {
				status: 200,
				body: { criuEnabled: true, version: "5.4.2", architecture: "x86_64" },
			};
		});

		const info = await backend.info();
		expect(info.criuEnabled).toBe(true);
		expect(info.version).toBe("5.4.2");
		expect(info.architecture).toBe("x86_64");
	});

	test("ensureImage() sends ref to daemon", async () => {
		let receivedBody: Record<string, unknown> | undefined;

		setup((req, body) => {
			expect(req.url).toBe("/images/ensure");
			receivedBody = JSON.parse(body.toString());
			return { status: 200, body: { image: "alpine:3.21", action: "pulled" } };
		});

		const result = await backend.ensureImage(
			{ ref: "alpine:3.21" },
			{ name: "test", version: "1.0" },
		);
		expect(result.image).toBe("alpine:3.21");
		expect(result.action).toBe("pulled");
		expect(receivedBody?.ref).toBe("alpine:3.21");
	});

	test("createContainer() sends spec and returns ID", async () => {
		let receivedBody: Record<string, unknown> | undefined;

		setup((_req, body) => {
			receivedBody = JSON.parse(body.toString());
			return { status: 201, body: { id: "ctr-123" } };
		});

		const id = await backend.createContainer({
			name: "test-ctr",
			image: "alpine:3.21",
		});
		expect(id).toBe("ctr-123");
		expect((receivedBody?.spec as Record<string, unknown>)?.name).toBe("test-ctr");
	});

	test("startContainer() sends POST to correct path", async () => {
		setup((req) => {
			expect(req.url).toBe("/containers/ctr-123/start");
			expect(req.method).toBe("POST");
			return { status: 204 };
		});

		await backend.startContainer("ctr-123");
	});

	test("inspectContainer() returns inspect data", async () => {
		setup((req) => {
			expect(req.url).toBe("/containers/ctr-123");
			expect(req.method).toBe("GET");
			return {
				status: 200,
				body: {
					Id: "ctr-123",
					State: { Running: true, Status: "running" },
					NetworkSettings: { Ports: {} },
				},
			};
		});

		const inspect = await backend.inspectContainer("ctr-123");
		expect(inspect.Id).toBe("ctr-123");
		expect(inspect.State.Running).toBe(true);
	});

	test("removeContainer() sends DELETE", async () => {
		setup((req) => {
			expect(req.url).toBe("/containers/ctr-123");
			expect(req.method).toBe("DELETE");
			return { status: 204 };
		});

		await backend.removeContainer("ctr-123");
	});

	test("exec() sends command and returns result", async () => {
		let receivedBody: Record<string, unknown> | undefined;

		setup((_req, body) => {
			receivedBody = JSON.parse(body.toString());
			return {
				status: 200,
				body: { exitCode: 0, stdout: "hello", stderr: "" },
			};
		});

		const result = await backend.exec("ctr-123", ["echo", "hello"]);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("hello");
		expect(receivedBody?.cmd).toEqual(["echo", "hello"]);
	});

	test("listContainers() returns IDs", async () => {
		setup(() => ({
			status: 200,
			body: { ids: ["ctr-1", "ctr-2"] },
		}));

		const ids = await backend.listContainers();
		expect(ids).toEqual(["ctr-1", "ctr-2"]);
	});

	test("checkpoint() sends request and returns result", async () => {
		setup((req, body) => {
			const parsed = JSON.parse(body.toString());
			expect(req.url).toBe("/containers/ctr-123/checkpoint");
			expect(parsed.archiveDir).toBe("/tmp/snapshots/snap-1");
			return {
				status: 200,
				body: {
					archivePath: "/tmp/snapshots/snap-1/checkpoint.tar.gz",
					exposedPorts: [8080],
				},
			};
		});

		const result = await backend.checkpoint("ctr-123", "/tmp/snapshots/snap-1");
		expect(result.archivePath).toBe("/tmp/snapshots/snap-1/checkpoint.tar.gz");
		expect(result.exposedPorts).toEqual([8080]);
	});

	test("restore() sends request and returns container ID", async () => {
		let receivedBody: Record<string, unknown> | undefined;

		setup((_req, body) => {
			receivedBody = JSON.parse(body.toString());
			return { status: 200, body: { id: "restored-456" } };
		});

		const id = await backend.restore(
			"/tmp/archive.tar.gz",
			"new-ctr",
			["8080"],
		);
		expect(id).toBe("restored-456");
		expect(receivedBody?.archivePath).toBe("/tmp/archive.tar.gz");
		expect(receivedBody?.name).toBe("new-ctr");
		expect(receivedBody?.publishPorts).toEqual(["8080"]);
	});

	test("throws on non-2xx response", async () => {
		setup(() => ({
			status: 403,
			body: { error: "privileged not allowed" },
		}));

		await expect(
			backend.createContainer({ name: "evil", image: "alpine" }),
		).rejects.toThrow(/privileged/);
	});
});
