import { describe, test, expect, afterEach } from "bun:test";
import * as http from "node:http";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateInstanceId } from "@boilerhouse/core";
import type { Workload } from "@boilerhouse/core";
import { PodmanRuntime, hasEstablishedConnections } from "./runtime";

/**
 * Creates a mock HTTP server on a temporary Unix socket.
 */
function createMockServer(
	handler: (
		req: http.IncomingMessage,
		body: Buffer,
	) => { status: number; body?: unknown; rawBody?: Buffer },
): { socketPath: string; server: http.Server; close: () => Promise<void> } {
	const tmpDir = mkdtempSync(join(tmpdir(), "podman-runtime-test-"));
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

describe("PodmanRuntime", () => {
	let mockServer: ReturnType<typeof createMockServer>;

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

	test("create() converts overlay_dirs to tmpfs mounts", async () => {
		let createBody: Record<string, unknown> | undefined;

		mockServer = createMockServer((req, body) => {
			const url = req.url ?? "";
			// Image exists check
			if (url.includes("/images/") && url.includes("/exists")) {
				return { status: 204 };
			}
			// Container create
			if (url.includes("/containers/create")) {
				createBody = JSON.parse(body.toString());
				return { status: 201, body: { Id: "ctr-123" } };
			}
			return { status: 404 };
		});

		const snapshotDir = mkdtempSync(join(tmpdir(), "bh-snap-"));
		const runtime = new PodmanRuntime({
			snapshotDir,
			socketPath: mockServer.socketPath,
		});

		const workload: Workload = {
			...BASE_WORKLOAD,
			filesystem: {
				overlay_dirs: ["/home/node/.openclaw", "/var/data"],
			},
		};

		await runtime.create(workload, generateInstanceId());

		expect(createBody?.mounts).toEqual([
			{ destination: "/home/node/.openclaw", type: "tmpfs", options: ["size=256m"] },
			{ destination: "/var/data", type: "tmpfs", options: ["size=256m"] },
		]);

		rmSync(snapshotDir, { recursive: true, force: true });
	});

	test("create() does not include mounts when no overlay_dirs", async () => {
		let createBody: Record<string, unknown> | undefined;

		mockServer = createMockServer((req, body) => {
			const url = req.url ?? "";
			if (url.includes("/images/") && url.includes("/exists")) {
				return { status: 204 };
			}
			if (url.includes("/containers/create")) {
				createBody = JSON.parse(body.toString());
				return { status: 201, body: { Id: "ctr-456" } };
			}
			return { status: 404 };
		});

		const snapshotDir = mkdtempSync(join(tmpdir(), "bh-snap-"));
		const runtime = new PodmanRuntime({
			snapshotDir,
			socketPath: mockServer.socketPath,
		});

		await runtime.create(BASE_WORKLOAD, generateInstanceId());

		expect(createBody?.mounts).toBeUndefined();

		rmSync(snapshotDir, { recursive: true, force: true });
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
