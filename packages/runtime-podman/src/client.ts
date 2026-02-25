import * as http from "node:http";
import { PodmanRuntimeError } from "./errors";

/** Parsed response from the Podman API. */
export interface PodmanResponse {
	status: number;
	body: unknown;
}

/** Container create specification for the Libpod API. */
export interface ContainerCreateSpec {
	name: string;
	image: string;
	command?: string[];
	entrypoint?: string[];
	env?: Record<string, string>;
	work_dir?: string;
	resource_limits?: {
		cpu?: { quota?: number; period?: number };
		memory?: { limit?: number };
	};
	portmappings?: Array<{
		container_port: number;
		host_port: number;
		protocol?: string;
	}>;
	netns?: { nsmode: string };
}

/** Subset of the container inspect response we use. */
export interface ContainerInspect {
	Id: string;
	State: { Running: boolean; Status: string };
	NetworkSettings: {
		Ports: Record<
			string,
			Array<{ HostIp: string; HostPort: string }> | null
		>;
	};
}

/** Subset of the podman info response we use. */
export interface PodmanInfo {
	host: {
		criuEnabled: boolean;
		criuVersion: string;
	};
	version: {
		Version: string;
	};
}

/** Result of exec start (non-interactive). */
export interface ExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface PodmanClientConfig {
	/**
	 * Path to the rootful podman API socket.
	 * @default "/run/boilerhouse/podman.sock"
	 * @example "/run/podman/podman.sock"
	 */
	socketPath: string;
	/**
	 * Libpod API version prefix.
	 * @default "v5.0.0"
	 */
	apiVersion?: string;
}

/**
 * HTTP client for the Podman Libpod REST API over a Unix socket.
 *
 * Uses `node:http` (implemented by Bun) with the `socketPath` option
 * to communicate with `podman system service`.
 */
export class PodmanClient {
	private readonly socketPath: string;
	private readonly apiBase: string;

	constructor(config: PodmanClientConfig) {
		this.socketPath = config.socketPath;
		this.apiBase = `/v${(config.apiVersion ?? "5.0.0").replace(/^v/, "")}`;
	}

	// ── Low-level HTTP methods ───────────────────────────────────────────────

	async get(path: string): Promise<PodmanResponse> {
		return this.request("GET", path);
	}

	async post(path: string, body?: object | Buffer): Promise<PodmanResponse> {
		return this.request("POST", path, body);
	}

	async del(path: string): Promise<PodmanResponse> {
		return this.request("DELETE", path);
	}

	/**
	 * POST that returns the raw response body as a Buffer.
	 * Used for checkpoint export where the response is a tar archive.
	 */
	async postRaw(path: string, body?: object | Buffer): Promise<Buffer> {
		return this.requestRaw("POST", path, body);
	}

	// ── High-level API methods ───────────────────────────────────────────────

	/** Fetch podman system info (includes CRIU status). */
	async info(): Promise<PodmanInfo> {
		const res = await this.get("/libpod/info");
		const data = res.body as Record<string, unknown>;

		const host = data.host as Record<string, unknown>;
		const version = data.version as Record<string, unknown>;

		return {
			host: {
				criuEnabled: Boolean(host?.criuEnabled),
				criuVersion: String(host?.criuVersion ?? ""),
			},
			version: {
				Version: String(version?.Version ?? "unknown"),
			},
		};
	}

	/**
	 * Pull an image by reference. Waits for pull to complete.
	 * The Libpod pull endpoint streams JSON objects; we wait for completion.
	 */
	async pullImage(ref: string): Promise<void> {
		const encoded = encodeURIComponent(ref);
		const res = await this.request(
			"POST",
			`/libpod/images/pull?reference=${encoded}`,
		);
		// Pull returns 200 with streaming JSON; check for error in last line
		if (res.status !== 200) {
			throw new PodmanRuntimeError(
				`Failed to pull image ${ref}: HTTP ${res.status}`,
			);
		}
	}

	/** Check if an image exists locally. */
	async imageExists(ref: string): Promise<boolean> {
		const encoded = encodeURIComponent(ref);
		try {
			const res = await this.get(
				`/libpod/images/${encoded}/exists`,
			);
			return res.status === 204;
		} catch {
			return false;
		}
	}

	/** Create a container from a spec. Returns the container ID. */
	async createContainer(spec: ContainerCreateSpec): Promise<string> {
		const body = this.buildCreateBody(spec);
		const res = await this.post("/libpod/containers/create", body);

		if (res.status !== 201) {
			const msg =
				(res.body as Record<string, unknown>)?.message ?? "unknown error";
			throw new PodmanRuntimeError(
				`Failed to create container: ${msg}`,
			);
		}

		const id = (res.body as { Id: string }).Id;
		return id;
	}

	/** Start a container by name or ID. */
	async startContainer(id: string): Promise<void> {
		const res = await this.post(
			`/libpod/containers/${encodeURIComponent(id)}/start`,
		);
		// 204 = started, 304 = already running
		if (res.status !== 204 && res.status !== 304) {
			throw new PodmanRuntimeError(
				`Failed to start container ${id}: HTTP ${res.status}`,
			);
		}
	}

	/** Force remove a container. Idempotent — ignores 404. */
	async removeContainer(id: string, force = true): Promise<void> {
		const res = await this.del(
			`/libpod/containers/${encodeURIComponent(id)}?force=${force}`,
		);
		// 200 = removed, 404 = already gone
		if (res.status !== 200 && res.status !== 404) {
			throw new PodmanRuntimeError(
				`Failed to remove container ${id}: HTTP ${res.status}`,
			);
		}
	}

	/** Inspect a container. Returns full container JSON. */
	async inspectContainer(id: string): Promise<ContainerInspect> {
		const res = await this.get(
			`/libpod/containers/${encodeURIComponent(id)}/json`,
		);
		if (res.status !== 200) {
			throw new PodmanRuntimeError(
				`Failed to inspect container ${id}: HTTP ${res.status}`,
			);
		}
		return res.body as ContainerInspect;
	}

	/**
	 * Checkpoint (CRIU snapshot) a container and return the archive as a Buffer.
	 * The archive is streamed back as the response body.
	 */
	async checkpointContainer(id: string): Promise<Buffer> {
		const path =
			`/libpod/containers/${encodeURIComponent(id)}/checkpoint` +
			`?export=true&leaveRunning=false`;
		return this.postRaw(path);
	}

	/**
	 * Restore a container from a checkpoint archive.
	 * Returns the new container ID.
	 */
	async restoreContainer(archive: Buffer, name: string): Promise<string> {
		const path =
			`/libpod/containers/restore` +
			`?import=true&name=${encodeURIComponent(name)}`;
		const res = await this.request("POST", path, archive);
		if (res.status !== 200) {
			const msg =
				(res.body as Record<string, unknown>)?.message ?? "unknown error";
			throw new PodmanRuntimeError(
				`Failed to restore container: ${msg}`,
			);
		}
		const id = (res.body as { Id: string }).Id;
		return id;
	}

	/**
	 * Create an exec instance inside a container.
	 * Returns the exec session ID.
	 */
	async execCreate(id: string, cmd: string[]): Promise<string> {
		const res = await this.post(
			`/libpod/containers/${encodeURIComponent(id)}/exec`,
			{
				Cmd: cmd,
				AttachStdout: true,
				AttachStderr: true,
			},
		);
		if (res.status !== 201) {
			throw new PodmanRuntimeError(
				`Failed to create exec session in ${id}: HTTP ${res.status}`,
			);
		}
		const execSessionId = (res.body as { Id: string }).Id;
		return execSessionId;
	}

	/**
	 * Start an exec session and capture output.
	 * Uses the non-interactive, non-streaming mode.
	 */
	async execStart(execId: string): Promise<ExecResult> {
		// Start the exec session — response streams stdout/stderr
		const raw = await this.requestRaw(
			"POST",
			`/libpod/exec/${encodeURIComponent(execId)}/start`,
			{ Detach: false, Tty: false },
		);

		// Inspect the exec session for exit code
		const inspectRes = await this.get(
			`/libpod/exec/${encodeURIComponent(execId)}/json`,
		);
		const inspectData = inspectRes.body as Record<string, unknown>;
		const exitCode = Number(inspectData.ExitCode ?? -1);

		// The multiplexed stream header format: [stream_type(1), 0, 0, size(4)]
		// For simplicity, capture all output. In non-TTY mode podman uses
		// Docker's multiplexed stream format.
		const { stdout, stderr } = this.demuxStream(raw);

		return {
			exitCode,
			stdout: stdout.trim(),
			stderr: stderr.trim(),
		};
	}

	// ── Internal helpers ─────────────────────────────────────────────────────

	/** Build the Libpod container create JSON body from our spec. */
	private buildCreateBody(spec: ContainerCreateSpec): Record<string, unknown> {
		const body: Record<string, unknown> = {
			name: spec.name,
			image: spec.image,
		};

		if (spec.command) {
			body.command = spec.command;
		}
		if (spec.entrypoint) {
			body.entrypoint = spec.entrypoint;
		}
		if (spec.env) {
			body.env = spec.env;
		}
		if (spec.work_dir) {
			body.work_dir = spec.work_dir;
		}
		if (spec.portmappings) {
			body.portmappings = spec.portmappings;
		}
		if (spec.netns) {
			body.netns = spec.netns;
		}
		if (spec.resource_limits) {
			body.resource_limits = spec.resource_limits;
		}

		return body;
	}

	/**
	 * Demultiplex Docker/Podman exec stream format.
	 *
	 * Non-TTY exec streams use an 8-byte header per frame:
	 *   [stream_type, 0, 0, 0, size_byte_3, size_byte_2, size_byte_1, size_byte_0]
	 *
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
	): Promise<PodmanResponse> {
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
					path: `${this.apiBase}${path}`,
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
					new PodmanRuntimeError(
						`Podman API request failed: ${err.message}`,
					),
				);
			});

			if (bodyData) {
				req.write(bodyData);
			}
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

			const req = http.request(
				{
					socketPath: this.socketPath,
					path: `${this.apiBase}${path}`,
					method,
					headers,
				},
				(res) => {
					// For non-2xx on raw requests, try to parse error
					if (res.statusCode && res.statusCode >= 400) {
						const chunks: Buffer[] = [];
						res.on("data", (chunk: Buffer) => chunks.push(chunk));
						res.on("end", () => {
							const raw = Buffer.concat(chunks).toString("utf-8");
							reject(
								new PodmanRuntimeError(
									`Podman API ${method} ${path} failed (${res.statusCode}): ${raw}`,
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
					new PodmanRuntimeError(
						`Podman API request failed: ${err.message}`,
					),
				);
			});

			if (bodyData) {
				req.write(bodyData);
			}
			req.end();
		});
	}
}
