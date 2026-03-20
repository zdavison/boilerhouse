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
	/**
	 * Arbitrary key-value labels attached to the container.
	 * @example { "boilerhouse.workload": "openclaw", "boilerhouse.version": "0.1.0" }
	 */
	labels?: Record<string, string>;
	/**
	 * Run the container in privileged mode.
	 * @default false
	 */
	privileged?: boolean;
	resource_limits?: {
		cpu?: { quota?: number; period?: number };
		memory?: { limit?: number };
	};
	portmappings?: Array<{
		container_port: number;
		host_port: number;
		protocol?: string;
	}>;
	mounts?: Array<{
		destination: string;
		type: string;
		source?: string;
		options?: string[];
	}>;
	netns?: { nsmode: string };
	/**
	 * Extra `/etc/hosts` entries for the container.
	 * @example ["host.containers.internal:host-gateway"]
	 */
	hostadd?: string[];
	/**
	 * Name of the podman pod to join. When set, the container shares
	 * the pod's network namespace (port mappings belong to the pod).
	 */
	pod?: string;
}

/** Pod create specification. */
export interface PodCreateSpec {
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
	 * @default "/var/run/boilerhouse/podman.sock"
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
		const raw = await this.requestRaw(
			"POST",
			`/libpod/images/pull?reference=${encoded}`,
		);

		// The pull API streams newline-delimited JSON objects.
		// The last object contains either { images: [...] } on success
		// or { error: "..." } on failure. Intermediate objects have { stream: "..." }.
		const text = raw.toString("utf-8").trim();
		const lines = text.split("\n").filter(Boolean);
		for (const line of lines) {
			try {
				const obj = JSON.parse(line) as Record<string, unknown>;
				if (obj.error) {
					throw new PodmanRuntimeError(
						`Failed to pull image ${ref}: ${String(obj.error)}`,
					);
				}
			} catch (e) {
				if (e instanceof PodmanRuntimeError) throw e;
			}
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
	 *
	 * Uses `import=true` which creates a fresh container from the archive
	 * (prevents ID/network collisions when restoring the same snapshot multiple
	 * times) and `tcpClose=true` to reset any captured TCP state so listening
	 * sockets rebind cleanly in the new namespace.
	 *
	 * @param publishPorts - Container port specs for fresh host port allocation.
	 *   Podman assigns a random available host port for each.
	 *   @example `["8080", "9090"]`
	 */
	async restoreContainer(archive: Buffer, name: string, publishPorts?: string[], pod?: string): Promise<string> {
		let path =
			`/libpod/containers/${encodeURIComponent(name)}/restore` +
			`?import=true&name=${encodeURIComponent(name)}` +
			`&tcpClose=true`;

		if (publishPorts && publishPorts.length > 0) {
			path += `&publishPorts=${encodeURIComponent(publishPorts.join(" "))}`;
		}

		if (pod) {
			path += `&pod=${encodeURIComponent(pod)}`;
		}

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

	/**
	 * Build an image from a tar build context.
	 *
	 * The context tar must include the Dockerfile. The response streams
	 * JSON build output; we wait for completion and check for errors.
	 *
	 * @param contextTar - tar archive of the build context
	 * @param tag - image tag to apply (e.g. "boilerhouse/httpserver:0.1.0")
	 * @param dockerfile - path to Dockerfile within the context
	 */
	async buildImage(
		contextTar: Buffer,
		tag: string,
		dockerfile = "Dockerfile",
	): Promise<void> {
		const params = new URLSearchParams({
			dockerfile,
			t: tag,
			rm: "true",
			forcerm: "true",
		});

		const raw = await this.requestRaw(
			"POST",
			`/libpod/build?${params.toString()}`,
			contextTar,
		);

		// The build API streams newline-delimited JSON objects.
		// Check the last object for an error field.
		const text = raw.toString("utf-8").trim();
		const lines = text.split("\n").filter(Boolean);
		for (const line of lines) {
			try {
				const obj = JSON.parse(line) as Record<string, unknown>;
				if (obj.error) {
					throw new PodmanRuntimeError(
						`Image build failed: ${String(obj.error)}`,
					);
				}
			} catch (e) {
				if (e instanceof PodmanRuntimeError) throw e;
				// Non-JSON lines are normal build output, ignore
			}
		}
	}

	/**
	 * Fetch stdout/stderr logs from a container.
	 *
	 * @param tail - Number of most recent lines to return. Defaults to 100.
	 */
	async containerLogs(id: string, tail = 100): Promise<string> {
		const path =
			`/libpod/containers/${encodeURIComponent(id)}/logs` +
			`?stdout=true&stderr=true&tail=${tail}`;
		const raw = await this.requestRaw("GET", path);
		const { stdout, stderr } = this.demuxStream(raw);
		// Interleave stdout and stderr (both are useful for diagnosing startup failures)
		const parts: string[] = [];
		if (stdout.trim()) parts.push(stdout.trim());
		if (stderr.trim()) parts.push(stderr.trim());
		return parts.join("\n");
	}

	// ── Internal helpers ─────────────────────────────────────────────────────

	/** Build the Libpod container create JSON body from our spec. */
	private buildCreateBody(spec: ContainerCreateSpec): Record<string, unknown> {
		const body: Record<string, unknown> = {
			name: spec.name,
			image: spec.image,
			privileged: false,
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
		if (spec.labels) {
			body.labels = spec.labels;
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
		if (spec.mounts && spec.mounts.length > 0) {
			body.mounts = spec.mounts;
		}
		if (spec.hostadd && spec.hostadd.length > 0) {
			body.hostadd = spec.hostadd;
		}
		if (spec.pod) {
			body.pod = spec.pod;
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
