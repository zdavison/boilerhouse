import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { DockerRuntimeError } from "./errors";

/** Parsed response from the Docker API. */
export interface DockerResponse {
	status: number;
	body: unknown;
}

/** Subset of container inspect response fields used by the runtime. */
export interface ContainerInspect {
	Id: string;
	State: { Running: boolean; Status: string };
	NetworkSettings: {
		Ports: Record<string, Array<{ HostIp: string; HostPort: string }> | null>;
	};
}

/** Subset of Docker container stats response. */
export interface ContainerStats {
	cpu_stats: {
		cpu_usage: { total_usage: number };
		system_cpu_usage: number;
		online_cpus: number;
	};
	precpu_stats: {
		cpu_usage: { total_usage: number };
		system_cpu_usage: number;
	};
	memory_stats: {
		usage: number;
		limit: number;
	};
}

/** Result of exec start. */
export interface ExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

/** Docker container create body (Engine API format). */
export interface ContainerCreateBody {
	Image: string;
	Cmd?: string[];
	Entrypoint?: string[];
	Env?: string[];
	User?: string;
	WorkingDir?: string;
	Labels?: Record<string, string>;
	ExposedPorts?: Record<string, Record<string, never>>;
	HostConfig: {
		CapDrop?: string[];
		CapAdd?: string[];
		SecurityOpt?: string[];
		PidMode?: string;
		NetworkMode?: string;
		PortBindings?: Record<string, Array<{ HostPort: string }>>;
		Binds?: string[];
		Tmpfs?: Record<string, string>;
		ReadonlyRootfs?: boolean;
		Resources?: {
			CpuQuota?: number;
			CpuPeriod?: number;
			Memory?: number;
		};
	};
}

export interface DockerClientConfig {
	/**
	 * Path to the Docker daemon Unix socket.
	 * @default auto-detected (checks /var/run/docker.sock, ~/.docker/run/docker.sock)
	 */
	socketPath?: string;
}

/**
 * Thin HTTP client for the Docker Engine API over a Unix socket.
 * Uses `node:http` (implemented by Bun) with the `socketPath` option.
 */
export class DockerClient {
	private readonly socketPath: string;
	private readonly apiBase = "/v1.47";

	constructor(config: DockerClientConfig = {}) {
		this.socketPath = config.socketPath ?? DockerClient.detectSocketPath();
	}

	/** Detect the Docker socket path, checking common locations. */
	private static detectSocketPath(): string {
		const candidates = [
			"/var/run/docker.sock",
			path.join(os.homedir(), ".docker/run/docker.sock"),
		];
		for (const p of candidates) {
			try {
				fs.accessSync(p);
				return p;
			} catch {
				// not accessible, try next
			}
		}
		// Fall back to the traditional default (will fail with a clear error)
		return "/var/run/docker.sock";
	}

	// ── Low-level HTTP methods ───────────────────────────────────────────────

	async get(path: string): Promise<DockerResponse> {
		return this.request("GET", path);
	}

	async post(path: string, body?: object | Buffer): Promise<DockerResponse> {
		return this.request("POST", path, body);
	}

	async del(path: string): Promise<DockerResponse> {
		return this.request("DELETE", path);
	}

	// ── High-level API methods ───────────────────────────────────────────────

	/** Check if the Docker daemon is reachable. */
	async ping(): Promise<boolean> {
		try {
			// /_ping is available without version prefix
			const res = await this.requestToPath("GET", "/_ping");
			return res.status === 200;
		} catch {
			return false;
		}
	}

	/** Check if an image exists locally. */
	async imageExists(ref: string): Promise<boolean> {
		try {
			const res = await this.get(`/images/${encodeURIComponent(ref)}/json`);
			return res.status === 200;
		} catch {
			return false;
		}
	}

	/**
	 * Pull an image by reference. The pull endpoint streams JSON progress objects.
	 */
	async pullImage(ref: string, onLog?: (line: string) => void): Promise<void> {
		const raw = await this.requestRaw(
			"POST",
			`/images/create?fromImage=${encodeURIComponent(ref)}`,
		);

		// Streaming newline-delimited JSON; forward progress and check for errors.
		const text = raw.toString("utf-8").trim();
		const lines = text.split("\n").filter(Boolean);
		for (const line of lines) {
			try {
				const obj = JSON.parse(line) as Record<string, unknown>;
				if (obj.error) {
					throw new DockerRuntimeError(
						`Failed to pull image ${ref}: ${String(obj.error)}`,
					);
				}
				if (onLog && typeof obj.status === "string") {
					const progress = typeof obj.progress === "string" ? ` ${obj.progress}` : "";
					onLog(`${obj.status}${progress}`);
				}
			} catch (e) {
				if (e instanceof DockerRuntimeError) throw e;
			}
		}
	}

	/**
	 * Build an image from a tar build context.
	 * The context tar must include the Dockerfile.
	 */
	async buildImage(
		contextTar: Buffer,
		tag: string,
		dockerfile = "Dockerfile",
		onLog?: (line: string) => void,
	): Promise<void> {
		const params = new URLSearchParams({
			t: tag,
			dockerfile,
			rm: "true",
			forcerm: "true",
		});

		const raw = await this.requestRaw(
			"POST",
			`/build?${params.toString()}`,
			contextTar,
		);

		const text = raw.toString("utf-8").trim();
		const lines = text.split("\n").filter(Boolean);
		for (const line of lines) {
			try {
				const obj = JSON.parse(line) as Record<string, unknown>;
				if (obj.error) {
					throw new DockerRuntimeError(
						`Image build failed: ${String(obj.error)}`,
					);
				}
				if (onLog && typeof obj.stream === "string") {
					const trimmed = obj.stream.replace(/\n$/, "");
					if (trimmed) onLog(trimmed);
				}
			} catch (e) {
				if (e instanceof DockerRuntimeError) throw e;
			}
		}
	}

	/**
	 * Create a container. Returns the container ID.
	 * @param name - Container name (used as the instance ID).
	 */
	async createContainer(name: string, body: ContainerCreateBody): Promise<string> {
		const res = await this.post(
			`/containers/create?name=${encodeURIComponent(name)}`,
			body,
		);

		if (res.status !== 201) {
			const msg =
				(res.body as Record<string, unknown>)?.message ?? "unknown error";
			throw new DockerRuntimeError(
				`Failed to create container ${name}: ${msg}`,
			);
		}

		return (res.body as { Id: string }).Id;
	}

	/** Start a container by name or ID. */
	async startContainer(id: string): Promise<void> {
		const res = await this.post(
			`/containers/${encodeURIComponent(id)}/start`,
		);
		// 204 = started, 304 = already running
		if (res.status !== 204 && res.status !== 304) {
			throw new DockerRuntimeError(
				`Failed to start container ${id}: HTTP ${res.status}`,
			);
		}
	}

	/** Restart a running container. */
	async restartContainer(id: string, timeoutSeconds = 10): Promise<void> {
		const res = await this.post(
			`/containers/${encodeURIComponent(id)}/restart?t=${timeoutSeconds}`,
		);
		if (res.status !== 204) {
			throw new DockerRuntimeError(
				`Failed to restart container ${id}: HTTP ${res.status}`,
			);
		}
	}

	/** Pause (freeze) all processes in a container via cgroups. */
	async pauseContainer(id: string): Promise<void> {
		const res = await this.post(
			`/containers/${encodeURIComponent(id)}/pause`,
		);
		if (res.status !== 204) {
			throw new DockerRuntimeError(
				`Failed to pause container ${id}: HTTP ${res.status}`,
			);
		}
	}

	/** Unpause a previously paused container. */
	async unpauseContainer(id: string): Promise<void> {
		const res = await this.post(
			`/containers/${encodeURIComponent(id)}/unpause`,
		);
		if (res.status !== 204) {
			throw new DockerRuntimeError(
				`Failed to unpause container ${id}: HTTP ${res.status}`,
			);
		}
	}

	/** Force remove a container. Idempotent — ignores 404. */
	async removeContainer(id: string): Promise<void> {
		const res = await this.del(
			`/containers/${encodeURIComponent(id)}?force=true`,
		);
		// 204 = removed, 404 = already gone
		if (res.status !== 204 && res.status !== 404) {
			throw new DockerRuntimeError(
				`Failed to remove container ${id}: HTTP ${res.status}`,
			);
		}
	}

	/**
	 * List container names managed by Boilerhouse (label: boilerhouse.managed=true, boilerhouse.role=workload).
	 */
	async listContainers(): Promise<string[]> {
		const filters = JSON.stringify({
			label: ["boilerhouse.managed=true", "boilerhouse.role=workload"],
		});
		const res = await this.get(`/containers/json?all=true&filters=${encodeURIComponent(filters)}`);
		if (res.status !== 200) return [];
		const containers = (res.body as Array<{ Names: string[] }>) ?? [];
		return containers.map((c) => c.Names[0]?.replace(/^\//, "") ?? "").filter(Boolean);
	}

	/** Get a one-shot stats snapshot for a container. */
	async containerStats(id: string): Promise<ContainerStats> {
		const res = await this.get(
			`/containers/${encodeURIComponent(id)}/stats?stream=false`,
		);
		if (res.status !== 200) {
			throw new DockerRuntimeError(
				`Failed to get stats for ${id}: HTTP ${res.status}`,
			);
		}
		return res.body as ContainerStats;
	}

	/** Inspect a container. Returns container metadata. */
	async inspectContainer(id: string): Promise<ContainerInspect> {
		const res = await this.get(
			`/containers/${encodeURIComponent(id)}/json`,
		);
		if (res.status !== 200) {
			throw new DockerRuntimeError(
				`Failed to inspect container ${id}: HTTP ${res.status}`,
			);
		}
		return res.body as ContainerInspect;
	}

	/**
	 * Create an exec instance inside a container. Returns the exec ID.
	 */
	async execCreate(id: string, cmd: string[], attachStdin = false): Promise<string> {
		const res = await this.post(
			`/containers/${encodeURIComponent(id)}/exec`,
			{
				Cmd: cmd,
				AttachStdin: attachStdin,
				AttachStdout: true,
				AttachStderr: true,
			},
		);
		if (res.status !== 201) {
			throw new DockerRuntimeError(
				`Failed to create exec in ${id}: HTTP ${res.status}`,
			);
		}
		return (res.body as { Id: string }).Id;
	}

	/**
	 * Start an exec session and capture stdout/stderr + exit code.
	 */
	async execStart(execId: string): Promise<ExecResult> {
		const raw = await this.requestRaw(
			"POST",
			`/exec/${encodeURIComponent(execId)}/start`,
			{ Detach: false, Tty: false },
		);

		const inspectRes = await this.get(
			`/exec/${encodeURIComponent(execId)}/json`,
		);
		const exitCode = Number(
			(inspectRes.body as Record<string, unknown>).ExitCode ?? -1,
		);

		const { stdout, stderr } = this.demuxStream(raw);
		return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
	}

	/**
	 * Start an exec session with stdin data piped in.
	 * Uses raw socket connection for the Docker API hijack protocol.
	 */
	async execStartWithStdin(execId: string, stdinData: Buffer): Promise<ExecResult> {
		const body = JSON.stringify({ Detach: false, Tty: false });
		const fullPath = `${this.apiBase}/exec/${encodeURIComponent(execId)}/start`;

		const raw = await new Promise<Buffer>((resolve, reject) => {
			const { connect } = require("node:net") as typeof import("node:net");
			const socket = connect(this.socketPath);

			socket.on("connect", () => {
				// Send raw HTTP request with upgrade headers
				const httpReq = [
					`POST ${fullPath} HTTP/1.1`,
					"Host: localhost",
					"Content-Type: application/json",
					`Content-Length: ${Buffer.byteLength(body)}`,
					"Connection: Upgrade",
					"Upgrade: tcp",
					"",
					body,
				].join("\r\n");
				socket.write(httpReq);
			});

			let headersParsed = false;
			let buf = Buffer.alloc(0);

			socket.on("data", (chunk: Buffer) => {
				buf = Buffer.concat([buf, chunk]);

				if (!headersParsed) {
					const headerEnd = buf.indexOf("\r\n\r\n");
					if (headerEnd === -1) return; // wait for full headers

					headersParsed = true;
					const responseBody = buf.subarray(headerEnd + 4);
					buf = responseBody;

					// Now pipe stdin data and close the write side
					socket.write(stdinData);
					socket.end();
				}
			});

			socket.on("end", () => resolve(buf));
			socket.on("error", reject);
		});

		const inspectRes = await this.get(
			`/exec/${encodeURIComponent(execId)}/json`,
		);
		const exitCode = Number(
			(inspectRes.body as Record<string, unknown>).ExitCode ?? -1,
		);

		const { stdout, stderr } = this.demuxStream(raw);
		return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
	}

	/**
	 * Execute a command inside a container and return the result.
	 */
	async exec(id: string, cmd: string[]): Promise<ExecResult> {
		const execId = await this.execCreate(id, cmd);
		return this.execStart(execId);
	}

	/**
	 * Execute a command with stdin data piped in.
	 */
	async execWithStdin(id: string, cmd: string[], stdinData: Buffer): Promise<ExecResult> {
		const execId = await this.execCreate(id, cmd, true);
		return this.execStartWithStdin(execId, stdinData);
	}

	/**
	 * Upload a tar archive into a container's filesystem.
	 * Uses PUT /containers/{id}/archive (equivalent to `docker cp`).
	 */
	async putArchive(id: string, destPath: string, tar: Buffer): Promise<void> {
		const qs = new URLSearchParams({ path: destPath });
		const res = await this.requestRaw(
			"PUT",
			`/containers/${encodeURIComponent(id)}/archive?${qs}`,
			tar,
		);
		// requestRaw rejects on 4xx/5xx, so if we get here it succeeded
		void res;
	}

	/**
	 * Wait for a container to exit and return the status code.
	 */
	async waitContainer(id: string): Promise<{ StatusCode: number }> {
		const res = await this.post(
			`/containers/${encodeURIComponent(id)}/wait`,
		);
		if (res.status !== 200) {
			throw new DockerRuntimeError(
				`Failed to wait for container ${id}: HTTP ${res.status}`,
			);
		}
		return res.body as { StatusCode: number };
	}

	/**
	 * Fetch stdout/stderr logs from a container.
	 * @param tail - Number of most recent lines to return.
	 */
	async containerLogs(id: string, tail = 100): Promise<string> {
		const raw = await this.requestRaw(
			"GET",
			`/containers/${encodeURIComponent(id)}/logs?stdout=1&stderr=1&tail=${tail}`,
		);
		const { stdout, stderr } = this.demuxStream(raw);
		const parts: string[] = [];
		if (stdout.trim()) parts.push(stdout.trim());
		if (stderr.trim()) parts.push(stderr.trim());
		return parts.join("\n");
	}

	// ── Internal helpers ─────────────────────────────────────────────────────

	/**
	 * Demultiplex Docker exec stream format.
	 * Non-TTY streams use an 8-byte header per frame:
	 *   [stream_type(1), 0, 0, 0, size_BE(4)]
	 * stream_type: 1 = stdout, 2 = stderr
	 */
	private demuxStream(raw: Buffer): { stdout: string; stderr: string } {
		const stdoutChunks: Buffer[] = [];
		const stderrChunks: Buffer[] = [];
		let offset = 0;

		while (offset + 8 <= raw.length) {
			const streamType = raw[offset]!;
			const size = raw.readUInt32BE(offset + 4);

			if (offset + 8 + size > raw.length) break;

			const payload = raw.subarray(offset + 8, offset + 8 + size);
			if (streamType === 1) {
				stdoutChunks.push(payload);
			} else if (streamType === 2) {
				stderrChunks.push(payload);
			}

			offset += 8 + size;
		}

		// If no valid frames were found, treat the entire buffer as stdout
		if (offset === 0 && raw.length > 0) {
			return { stdout: raw.toString("utf-8"), stderr: "" };
		}

		return {
			stdout: Buffer.concat(stdoutChunks).toString("utf-8"),
			stderr: Buffer.concat(stderrChunks).toString("utf-8"),
		};
	}

	private request(
		method: string,
		path: string,
		body?: object | Buffer,
	): Promise<DockerResponse> {
		return this.requestToPath(method, `${this.apiBase}${path}`, body);
	}

	private requestToPath(
		method: string,
		fullPath: string,
		body?: object | Buffer,
	): Promise<DockerResponse> {
		return new Promise((resolve, reject) => {
			const isBuffer = Buffer.isBuffer(body);
			const bodyData = body
				? isBuffer
					? body
					: Buffer.from(JSON.stringify(body))
				: undefined;

			const headers: Record<string, string> = {};
			if (bodyData) {
				headers["Content-Type"] = isBuffer
					? "application/x-tar"
					: "application/json";
				headers["Content-Length"] = String(bodyData.length);
			}

			const req = http.request(
				{
					socketPath: this.socketPath,
					path: fullPath,
					method,
					headers,
				},
				(res) => {
					const chunks: Buffer[] = [];
					res.on("data", (chunk: Buffer) => chunks.push(chunk));
					res.on("end", () => {
						const raw = Buffer.concat(chunks);
						let parsed: unknown;
						try {
							const text = raw.toString("utf-8");
							parsed = text ? JSON.parse(text) : null;
						} catch {
							parsed = raw.toString("utf-8");
						}
						resolve({ status: res.statusCode ?? 0, body: parsed });
					});
					res.on("error", reject);
				},
			);

			req.on("error", (err) => {
				reject(
					new DockerRuntimeError(
						`Docker API request failed: ${err.message}`,
					),
				);
			});

			if (bodyData) req.write(bodyData);
			req.end();
		});
	}

	private requestRaw(
		method: string,
		path: string,
		body?: object | Buffer,
	): Promise<Buffer> {
		return new Promise((resolve, reject) => {
			const isBuffer = Buffer.isBuffer(body);
			const bodyData = body
				? isBuffer
					? body
					: Buffer.from(JSON.stringify(body))
				: undefined;

			const headers: Record<string, string> = {};
			if (bodyData) {
				headers["Content-Type"] = isBuffer
					? "application/x-tar"
					: "application/json";
				headers["Content-Length"] = String(bodyData.length);
			}

			// For requestRaw, check if path already has a prefix
			const fullPath = path.startsWith("/v") || path.startsWith("/_")
				? path
				: `${this.apiBase}${path}`;

			const req = http.request(
				{
					socketPath: this.socketPath,
					path: fullPath,
					method,
					headers,
				},
				(res) => {
					if (res.statusCode && res.statusCode >= 400) {
						const chunks: Buffer[] = [];
						res.on("data", (chunk: Buffer) => chunks.push(chunk));
						res.on("end", () => {
							const raw = Buffer.concat(chunks).toString("utf-8");
							reject(
								new DockerRuntimeError(
									`Docker API ${method} ${path} failed (${res.statusCode}): ${raw}`,
								),
							);
						});
						res.on("error", reject);
						return;
					}

					const chunks: Buffer[] = [];
					res.on("data", (chunk: Buffer) => chunks.push(chunk));
					res.on("end", () => resolve(Buffer.concat(chunks)));
					res.on("error", reject);
				},
			);

			req.on("error", (err) => {
				reject(
					new DockerRuntimeError(
						`Docker API request failed: ${err.message}`,
					),
				);
			});

			if (bodyData) req.write(bodyData);
			req.end();
		});
	}
}
