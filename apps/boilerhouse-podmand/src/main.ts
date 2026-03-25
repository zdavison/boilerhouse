import { mkdirSync, existsSync, rmSync, chmodSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Subprocess } from "bun";
import { context, propagation, trace, SpanStatusCode } from "@opentelemetry/api";
import { DEFAULT_RUNTIME_SOCKET, DEFAULT_PODMAN_SOCKET, DEFAULT_SNAPSHOT_DIR } from "@boilerhouse/core";
import { PodmanClient } from "@boilerhouse/runtime-podman";
import type { ContainerCreateSpec } from "@boilerhouse/runtime-podman";
import { validateContainerSpec, PolicyViolationError } from "./validate";
import { ensurePodmanMachine, detectPodmanSocket } from "./macos";
import { enrichCheckpointError } from "./criu";

export interface DaemonConfig {
	/**
	 * Path for the podman API socket.
	 * When `managePodman` is true (default), boilerhouse-podmand spawns podman
	 * and creates this socket. Otherwise it connects to an existing socket.
	 *
	 * @default (linux) "/var/run/boilerhouse/podman.sock".
	 * @default (macOS) discovered at runtime via `podman machine inspect` (no static default).
	 */
	podmanSocketPath: string;
	/** Path for the daemon's own listening socket. */
	listenSocketPath: string;
	/** Directory for storing checkpoint archives. */
	snapshotDir: string;
	/** age secret key ("AGE-SECRET-KEY-1...") for encrypting snapshot archives at rest. */
	encryptionKey?: string;
	/** Base directory for resolving workload Dockerfiles. */
	workloadsDir?: string;
	/**
	 * When true, boilerhouse-podmand spawns and manages the `podman system service`
	 * child process. The podman socket is created with mode 0600 (root-only).
	 * On stop, the podman process is killed.
	 * @default true
	 */
	managePodman?: boolean;
}

const IS_MACOS = process.platform === "darwin";

/**
 * Spawns `podman system service` (Linux) or ensures a podman machine is
 * running (macOS) and waits for the API socket.
 *
 * On Linux, returns the child process handle. On macOS, returns `undefined`
 * because the podman machine manages its own lifecycle.
 */
async function startPodman(socketPath: string): Promise<Subprocess | undefined> {
	if (IS_MACOS) {
		await ensurePodmanMachine();
		return undefined;
	}
	return startPodmanService(socketPath);
}

/** Linux: spawn `podman system service` and wait for the socket. */
async function startPodmanService(socketPath: string): Promise<Subprocess> {
	const socketDir = dirname(socketPath);
	mkdirSync(socketDir, { recursive: true });

	// Clean up stale socket
	if (existsSync(socketPath)) {
		rmSync(socketPath, { force: true });
	}

	const proc = Bun.spawn(
		["podman", "system", "service", "--time=0", `unix://${socketPath}`],
		{ stdout: "inherit", stderr: "inherit" },
	);

	// Race: wait for socket to appear OR process to exit (whichever comes first)
	const deadline = Date.now() + 10_000;
	while (Date.now() < deadline) {
		if (existsSync(socketPath)) {
			// Lock down the socket to root-only
			chmodSync(socketPath, 0o600);
			return proc;
		}

		// Check if process already exited
		// Bun's Subprocess has .exitCode which is null while running
		if (proc.exitCode !== null) {
			throw new Error(
				`podman system service exited with code ${proc.exitCode} before creating socket`,
			);
		}

		await new Promise((r) => setTimeout(r, 100));
	}

	proc.kill();
	throw new Error(
		`Podman socket did not appear at ${socketPath} within 10s`,
	);
}

/**
 * Creates and starts the boilerhouse-podmand daemon.
 * Returns a handle with a `stop()` function.
 */
export async function createDaemon(config: DaemonConfig): Promise<{ stop: () => void }> {
	const managePodman = config.managePodman ?? true;
	let podmanProc: Subprocess | undefined;

	// Start podman if we're managing it
	if (managePodman) {
		podmanProc = await startPodman(config.podmanSocketPath);
	}

	// On macOS the config socket path is irrelevant — discover the real one
	// from `podman machine inspect`.
	const podmanSocketPath = IS_MACOS && managePodman
		? detectPodmanSocket()
		: config.podmanSocketPath;

	const client = new PodmanClient({ socketPath: podmanSocketPath });

	// In-memory container registry.
	// Clients address containers by name (instanceId), but podman returns
	// its own hex IDs. We keep both mappings so lookups work either way.
	const nameToId = new Map<string, string>(); // container name → podman ID
	const idToName = new Map<string, string>(); // podman ID → container name

	function registerContainer(podmanId: string, name: string): void {
		nameToId.set(name, podmanId);
		idToName.set(podmanId, name);
	}

	function unregisterByName(name: string): void {
		const podmanId = nameToId.get(name);
		nameToId.delete(name);
		if (podmanId) idToName.delete(podmanId);
	}

	function unregisterByPodmanId(podmanId: string): void {
		const name = idToName.get(podmanId);
		idToName.delete(podmanId);
		if (name) nameToId.delete(name);
	}

	/**
	 * Resolve an identifier (name or podman ID) to a podman ID.
	 * Returns undefined if the container is not in the registry.
	 */
	function resolveContainer(identifier: string): string | undefined {
		// Try as name first (most common path from PodmanRuntime)
		const byName = nameToId.get(identifier);
		if (byName) return byName;
		// Fallback: check if it's a podman ID directly
		if (idToName.has(identifier)) return identifier;
		return undefined;
	}

	// Recover existing managed containers from podman
	try {
		const res = await client.get(
			'/libpod/containers/json?filters={"label":["managed-by=boilerhouse-podmand"]}',
		);
		const containers = res.body as Array<{ Id: string; Names?: string[] }>;
		for (const c of containers) {
			const name = c.Names?.[0] ?? c.Id;
			registerContainer(c.Id, name);
		}
	} catch {
		// Podman not reachable at startup — registry stays empty
	}

	mkdirSync(config.snapshotDir, { recursive: true, mode: 0o700 });

	// Directory for sidecar proxy config files (bind-mounted into containers)
	const configFilesDir = resolve(config.snapshotDir, "..", "proxy-configs");
	mkdirSync(configFilesDir, { recursive: true, mode: 0o700 });

	function jsonResponse(status: number, body?: unknown): Response {
		if (body === undefined || body === null) {
			return new Response(null, { status });
		}
		return new Response(JSON.stringify(body), {
			status,
			headers: { "Content-Type": "application/json" },
		});
	}

	async function readJsonBody(req: Request): Promise<unknown> {
		const text = await req.text();
		return text ? JSON.parse(text) : null;
	}

	/** Route dispatch. */
	async function handleRequest(req: Request): Promise<Response> {
		const url = new URL(req.url, "http://localhost");
		const { pathname } = url;
		const method = req.method;

		try {
			// GET /healthz
			if (method === "GET" && pathname === "/healthz") {
				return jsonResponse(200, { status: "ok" });
			}

			// GET /info
			if (method === "GET" && pathname === "/info") {
				return await handleInfo();
			}

			// POST /images/ensure
			if (method === "POST" && pathname === "/images/ensure") {
				return await handleEnsureImage(req);
			}

			// GET /images — list images
			if (method === "GET" && pathname === "/images") {
				return await handleListImages();
			}

			// DELETE /images/:ref — remove a single image
			const imageDeleteMatch = pathname.match(/^\/images\/(.+)$/);
			if (method === "DELETE" && imageDeleteMatch) {
				return await handleDeleteImage(decodeURIComponent(imageDeleteMatch[1]!));
			}

			// GET /containers (list)
			if (method === "GET" && pathname === "/containers") {
				return jsonResponse(200, { ids: Array.from(nameToId.keys()) });
			}

			// POST /containers (create)
			if (method === "POST" && pathname === "/containers") {
				return await handleCreateContainer(req);
			}

			// Routes with container ID
			const containerMatch = pathname.match(/^\/containers\/([^/]+)$/);
			if (containerMatch) {
				const id = containerMatch[1]!;

				if (method === "GET") {
					return await handleInspectContainer(id);
				}

				if (method === "DELETE") {
					return await handleRemoveContainer(id);
				}
			}

			// POST /containers/:id/start
			const startMatch = pathname.match(/^\/containers\/([^/]+)\/start$/);
			if (method === "POST" && startMatch) {
				return await handleStartContainer(startMatch[1]!);
			}

			// POST /containers/:id/checkpoint
			const checkpointMatch = pathname.match(/^\/containers\/([^/]+)\/checkpoint$/);
			if (method === "POST" && checkpointMatch) {
				return await handleCheckpoint(checkpointMatch[1]!, req);
			}

			// POST /containers/restore
			if (method === "POST" && pathname === "/containers/restore") {
				return await handleRestore(req);
			}

			// GET /containers/:id/logs
			const logsMatch = pathname.match(/^\/containers\/([^/]+)\/logs$/);
			if (method === "GET" && logsMatch) {
				return await handleLogs(logsMatch[1]!, url);
			}

			// POST /containers/:id/exec
			const execMatch = pathname.match(/^\/containers\/([^/]+)\/exec$/);
			if (method === "POST" && execMatch) {
				return await handleExec(execMatch[1]!, req);
			}

			// ── Pod routes ──────────────────────────────────────────────

			// GET /pods (list)
			if (method === "GET" && pathname === "/pods") {
				return await handleListPods();
			}

			// POST /pods (create)
			if (method === "POST" && pathname === "/pods") {
				return await handleCreatePod(req);
			}

			// GET /pods/:name (inspect)
			const podInspectMatch = pathname.match(/^\/pods\/([^/]+)$/);
			if (method === "GET" && podInspectMatch) {
				return await handleInspectPod(podInspectMatch[1]!);
			}

			// POST /pods/:name/start
			const podStartMatch = pathname.match(/^\/pods\/([^/]+)\/start$/);
			if (method === "POST" && podStartMatch) {
				return await handleStartPod(podStartMatch[1]!);
			}

			// DELETE /pods/:name
			const podDeleteMatch = pathname.match(/^\/pods\/([^/]+)$/);
			if (method === "DELETE" && podDeleteMatch) {
				return await handleRemovePod(podDeleteMatch[1]!);
			}

			// ── File routes ─────────────────────────────────────────────

			// POST /files (write)
			if (method === "POST" && pathname === "/files") {
				return await handleWriteFile(req);
			}

			// DELETE /files/:name
			const fileDeleteMatch = pathname.match(/^\/files\/([^/]+)$/);
			if (method === "DELETE" && fileDeleteMatch) {
				return handleRemoveFile(decodeURIComponent(fileDeleteMatch[1]!));
			}

			return jsonResponse(404, { error: "not found" });
		} catch (err) {
			if (err instanceof PolicyViolationError) {
				return jsonResponse(403, { error: err.message });
			}
			const message = err instanceof Error ? err.message : String(err);
			return jsonResponse(500, { error: message });
		}
	}

	// ── Route handlers ──────────────────────────────────────────────────────

	async function handleInfo(): Promise<Response> {
		const info = await client.info();
		const arch = await getArchitecture();
		return jsonResponse(200, {
			criuEnabled: info.host.criuEnabled,
			version: info.version.Version,
			architecture: arch,
		});
	}

	async function handleEnsureImage(req: Request): Promise<Response> {
		const body = (await readJsonBody(req)) as {
			ref?: string;
			dockerfile?: string;
			tag?: string;
		};

		if (body.ref) {
			const exists = await client.imageExists(body.ref);
			if (!exists) {
				await client.pullImage(body.ref);
				return jsonResponse(200, { image: body.ref, action: "pulled" });
			}
			return jsonResponse(200, { image: body.ref, action: "cached" });
		}

		if (body.dockerfile && body.tag) {
			const exists = await client.imageExists(body.tag);
			if (exists) {
				return jsonResponse(200, { image: body.tag, action: "cached" });
			}

			// Resolve the Dockerfile path relative to the workloads directory
			const dockerfilePath = config.workloadsDir
				? resolve(config.workloadsDir, body.dockerfile)
				: body.dockerfile;
			const contextDir = dirname(dockerfilePath);

			if (!existsSync(dockerfilePath)) {
				return jsonResponse(400, { error: `Dockerfile not found: ${dockerfilePath}` });
			}

			// Create a tar archive of the build context
			const tar = Bun.spawnSync(["tar", "-cf", "-", "-C", contextDir, "."], {
				stdout: "pipe",
				stderr: "pipe",
			});
			if (tar.exitCode !== 0) {
				const stderr = new TextDecoder().decode(tar.stderr);
				return jsonResponse(500, { error: `Failed to create build context: ${stderr}` });
			}

			await client.buildImage(Buffer.from(tar.stdout), body.tag);
			return jsonResponse(200, { image: body.tag, action: "built" });
		}

		return jsonResponse(400, { error: "Must provide ref or (dockerfile + tag)" });
	}

	async function handleListImages(): Promise<Response> {
		const res = await client.get("/libpod/images/json");
		const images = res.body as Array<{ Id: string; RepoTags?: string[] }>;
		return jsonResponse(200, images.map((img) => ({
			id: img.Id,
			tags: img.RepoTags ?? [],
		})));
	}

	async function handleDeleteImage(ref: string): Promise<Response> {
		const res = await client.del(`/libpod/images/${encodeURIComponent(ref)}?force=true`);
		if (res.status !== 200 && res.status !== 404) {
			return jsonResponse(res.status, { error: `Failed to remove image: HTTP ${res.status}` });
		}
		return jsonResponse(200, { removed: ref });
	}

	async function handleCreateContainer(req: Request): Promise<Response> {
		const body = (await readJsonBody(req)) as { spec: ContainerCreateSpec };

		// Validate and sanitize the spec — throws PolicyViolationError on violation
		const sanitized = validateContainerSpec(body.spec, {
			allowedBindSources: [configFilesDir],
		});

		const podmanId = await client.createContainer(sanitized);
		registerContainer(podmanId, sanitized.name);

		return jsonResponse(201, { id: podmanId });
	}

	async function handleStartContainer(identifier: string): Promise<Response> {
		const podmanId = resolveContainer(identifier);
		if (!podmanId) {
			return jsonResponse(404, { error: `Container ${identifier} not in registry` });
		}

		await client.startContainer(podmanId);
		return jsonResponse(204);
	}

	async function handleInspectContainer(identifier: string): Promise<Response> {
		// Resolve from registry, or pass through raw podman IDs (e.g. infra containers)
		const podmanId = resolveContainer(identifier) ?? identifier;

		try {
			const inspect = await client.inspectContainer(podmanId);
			return jsonResponse(200, inspect);
		} catch {
			return jsonResponse(404, { error: `Container ${identifier} not found` });
		}
	}

	async function handleRemoveContainer(identifier: string): Promise<Response> {
		const podmanId = resolveContainer(identifier);
		if (!podmanId) {
			// Idempotent — already gone (matches PodmanClient.removeContainer behavior)
			return jsonResponse(204);
		}

		await client.removeContainer(podmanId, true);
		unregisterByPodmanId(podmanId);
		return jsonResponse(204);
	}

	async function handleCheckpoint(identifier: string, req: Request): Promise<Response> {
		const podmanId = resolveContainer(identifier);
		if (!podmanId) {
			return jsonResponse(404, { error: `Container ${identifier} not in registry` });
		}

		const body = (await readJsonBody(req)) as { archiveDir: string };

		const { rewriteCheckpointPorts } = await import("@boilerhouse/runtime-podman");
		const { encryptArchive } = await import("@boilerhouse/core");
		const { chmodSync } = await import("node:fs");
		const { join } = await import("node:path");

		const archivePath = join(body.archiveDir, "checkpoint.tar.gz");
		let archiveBuffer: Buffer;
		try {
			archiveBuffer = await client.checkpointContainer(podmanId);
		} catch (err: unknown) {
			return await enrichCheckpointError(err, client, podmanId);
		}

		const { archive: rewrittenArchive, containerPorts } =
			await rewriteCheckpointPorts(archiveBuffer);

		// Encrypt the archive at rest if an encryption key is configured
		const dataToWrite = config.encryptionKey
			? await encryptArchive(rewrittenArchive, config.encryptionKey)
			: rewrittenArchive;

		await Bun.write(archivePath, dataToWrite);
		chmodSync(archivePath, 0o600);

		// Container is stopped/destroyed by podman after checkpoint,
		// but stays in the registry until the caller explicitly DELETEs it.

		return jsonResponse(200, {
			archivePath,
			exposedPorts: containerPorts,
			encrypted: !!config.encryptionKey,
		});
	}

	async function handleRestore(req: Request): Promise<Response> {
		const body = (await readJsonBody(req)) as {
			archivePath: string;
			name: string;
			publishPorts?: string[];
			pod?: string;
			encrypted?: boolean;
		};

		const { decryptArchive } = await import("@boilerhouse/core");

		// Extract W3C trace context from incoming headers so daemon spans are
		// children of the restore.criu span in the API process.
		// We pass parentCtx explicitly to each startActiveSpan call for clarity.
		const parentCtx = propagation.extract(
			context.active(),
			Object.fromEntries(req.headers.entries()),
		);
		const daemonTracer = trace.getTracer("boilerhouse");

		let archive: Buffer;

		archive = await daemonTracer.startActiveSpan("daemon.archive_read", { }, parentCtx, async (span) => {
			try {
				const data = await Bun.file(body.archivePath).arrayBuffer();
				span.setAttribute("archive.size_bytes", data.byteLength);
				span.setAttribute("archive.encrypted", body.encrypted ?? false);
				return Buffer.from(data);
			} catch (err) {
				span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
				throw err;
			} finally {
				span.end();
			}
		});

		// Decrypt if the archive was encrypted at rest
		if (body.encrypted) {
			if (!config.encryptionKey) {
				return jsonResponse(403, {
					error: "Archive is encrypted but daemon has no encryption key configured",
				});
			}
			try {
				archive = await daemonTracer.startActiveSpan("daemon.archive_decrypt", { }, parentCtx, async (span) => {
					span.setAttribute("archive.size_bytes", archive.length);
					try {
						const decrypted = await decryptArchive(archive, config.encryptionKey!);
						span.setAttribute("archive.decrypted_size_bytes", decrypted.length);
						return decrypted;
					} catch (err) {
						span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
						throw err;
					} finally {
						span.end();
					}
				});
			} catch {
				return jsonResponse(403, { error: "Archive decryption failed" });
			}
		}

		const { id: podmanId, stats } = await daemonTracer.startActiveSpan("daemon.podman_restore", { }, parentCtx, async (span) => {
			span.setAttribute("container.name", body.name);
			if (body.pod) span.setAttribute("pod.name", body.pod);
			try {
				const result = await client.restoreContainer(archive, body.name, body.publishPorts, body.pod);
				span.setAttribute("container.id", result.id);
				if (result.stats) {
					const s = result.stats;
					if (s.forking_time != null) span.setAttribute("criu.forking_time_us", s.forking_time);
					if (s.restore_time != null) span.setAttribute("criu.restore_time_us", s.restore_time);
					if (s.pages_restored != null) span.setAttribute("criu.pages_restored", s.pages_restored);
					if (s.runtime_restore_duration != null) span.setAttribute("criu.runtime_restore_duration_us", s.runtime_restore_duration);
					if (s.podman_restore_duration != null) span.setAttribute("criu.podman_restore_duration_us", s.podman_restore_duration);
				}
				return result;
			} catch (err) {
				span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
				throw err;
			} finally {
				span.end();
			}
		});

		registerContainer(podmanId, body.name);
		return jsonResponse(200, { id: podmanId });
	}

	async function handleExec(identifier: string, req: Request): Promise<Response> {
		const podmanId = resolveContainer(identifier);
		if (!podmanId) {
			return jsonResponse(404, { error: `Container ${identifier} not in registry` });
		}

		const body = (await readJsonBody(req)) as { cmd: string[] };
		const execId = await client.execCreate(podmanId, body.cmd);
		const result = await client.execStart(execId);

		return jsonResponse(200, {
			exitCode: result.exitCode,
			stdout: result.stdout,
			stderr: result.stderr,
		});
	}

	async function handleLogs(identifier: string, url: URL): Promise<Response> {
		const podmanId = resolveContainer(identifier);
		if (!podmanId) {
			return jsonResponse(404, { error: `Container ${identifier} not in registry` });
		}

		const tail = Number(url.searchParams.get("tail") ?? 100);
		const logs = await client.containerLogs(podmanId, tail);
		return jsonResponse(200, { logs });
	}

	// ── Pod handlers ────────────────────────────────────────────────────────

	async function handleListPods(): Promise<Response> {
		const res = await client.get(
			'/libpod/pods/json?filters={"label":["managed-by=boilerhouse-podmand"]}',
		);
		if (res.status !== 200 && res.status !== 404) {
			return jsonResponse(res.status, { error: `Failed to list pods: HTTP ${res.status}` });
		}
		const pods = (res.body as Array<{ Name: string }>) ?? [];
		return jsonResponse(200, { names: pods.map((p) => p.Name) });
	}

	async function handleInspectPod(name: string): Promise<Response> {
		const res = await client.get(`/libpod/pods/${encodeURIComponent(name)}/json`);
		if (res.status !== 200) {
			return jsonResponse(res.status, { error: `Failed to inspect pod: HTTP ${res.status}` });
		}
		const pod = res.body as Record<string, unknown>;
		const infraId = pod.InfraContainerID as string | undefined;
		return jsonResponse(200, { infraContainerId: infraId ?? "" });
	}

	async function handleCreatePod(req: Request): Promise<Response> {
		const body = (await readJsonBody(req)) as {
			name: string;
			portmappings?: Array<{ container_port: number; host_port: number; protocol?: string }>;
			netns?: { nsmode: string };
		};

		const podSpec: Record<string, unknown> = {
			name: body.name,
			labels: { "managed-by": "boilerhouse-podmand" },
		};

		if (body.portmappings) {
			podSpec.portmappings = body.portmappings;
		}
		if (body.netns) {
			podSpec.netns = body.netns;
		}

		const res = await client.post("/libpod/pods/create", podSpec);
		if (res.status !== 201 && res.status !== 200) {
			const msg = (res.body as Record<string, unknown>)?.message ?? "unknown error";
			return jsonResponse(res.status, { error: `Failed to create pod: ${msg}` });
		}

		const podId = (res.body as { Id: string }).Id;

		// Resolve the dynamically-assigned host ports from the infra container.
		// Ports are allocated at pod creation time, so we can return them here
		// and avoid two extra round-trips on every restore/start.
		let hostPorts: number[] = [];
		try {
			const podJson = await client.get(`/libpod/pods/${encodeURIComponent(podId)}/json`);
			const infraId = (podJson.body as Record<string, unknown>)?.InfraContainerID as string | undefined;
			if (infraId) {
				const infraInspect = await client.inspectContainer(infraId);
				const portsMap = infraInspect.NetworkSettings?.Ports;
				if (portsMap) {
					for (const bindings of Object.values(portsMap)) {
						if (!bindings) continue;
						for (const binding of bindings) {
							const port = Number(binding.HostPort);
							if (port > 0) hostPorts.push(port);
						}
					}
				}
			}
		} catch {
			// Best-effort — caller can fall back to inspecting later if needed
		}

		return jsonResponse(201, { id: podId, hostPorts });
	}

	async function handleStartPod(name: string): Promise<Response> {
		const res = await client.post(`/libpod/pods/${encodeURIComponent(name)}/start`);
		// 200 = started, 304 = already running
		if (res.status !== 200 && res.status !== 304) {
			const msg = (res.body as Record<string, unknown>)?.message ?? "unknown error";
			return jsonResponse(res.status, { error: `Failed to start pod: ${msg}` });
		}
		return jsonResponse(204);
	}

	async function handleRemovePod(name: string): Promise<Response> {
		const res = await client.del(`/libpod/pods/${encodeURIComponent(name)}?force=true`);
		// 200 = removed, 404 = already gone
		if (res.status !== 200 && res.status !== 404) {
			const msg = (res.body as Record<string, unknown>)?.message ?? "unknown error";
			return jsonResponse(res.status, { error: `Failed to remove pod: ${msg}` });
		}

		// Unregister any containers that were in this pod
		// (pod removal cascades to all containers)
		for (const [containerName] of Array.from(nameToId.entries())) {
			if (containerName.startsWith(`${name}-`) || containerName === name) {
				unregisterByName(containerName);
			}
		}

		return jsonResponse(204);
	}

	// ── File handlers ───────────────────────────────────────────────────────

	async function handleWriteFile(req: Request): Promise<Response> {
		const body = (await readJsonBody(req)) as { name: string; content: string };

		const filePath = join(configFilesDir, body.name);
		writeFileSync(filePath, body.content, { mode: 0o600 });

		return jsonResponse(200, { path: filePath });
	}

	function handleRemoveFile(name: string): Response {
		const filePath = join(configFilesDir, name);
		try {
			rmSync(filePath, { force: true });
		} catch {
			// Idempotent — ignore if file doesn't exist
		}
		return jsonResponse(204);
	}

	// ── Helpers ──────────────────────────────────────────────────────────────

	async function getArchitecture(): Promise<string> {
		const proc = Bun.spawn(["uname", "-m"], { stdout: "pipe" });
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		return stdout.trim() || "unknown";
	}

	// ── Start server ─────────────────────────────────────────────────────────

	const server = Bun.serve({
		unix: config.listenSocketPath,
		fetch: handleRequest,
	});

	return {
		stop: () => {
			server.stop();
			if (podmanProc) {
				podmanProc.kill();
			}
		},
	};
}

// ── CLI entrypoint ──────────────────────────────────────────────────────────

if (import.meta.main) {
	const podmanSocketPath = process.env.PODMAN_SOCKET ?? DEFAULT_PODMAN_SOCKET ?? "/var/run/boilerhouse/podman.sock";
	const listenSocketPath = process.env.LISTEN_SOCKET ?? DEFAULT_RUNTIME_SOCKET;
	const snapshotDir = process.env.SNAPSHOT_DIR ?? DEFAULT_SNAPSHOT_DIR;
	const encryptionKey = process.env.BOILERHOUSE_ENCRYPTION_KEY;
	const workloadsDir = process.env.WORKLOADS_DIR;

	// Initialise OTEL tracing if a collector endpoint is configured.
	// Metrics (Prometheus) are disabled — the daemon has no metrics endpoint.
	const { initO11y } = await import("@boilerhouse/o11y");
	initO11y({ metricsEnabled: false });

	let daemon: { stop: () => void };
	try {
		daemon = await createDaemon({
			podmanSocketPath,
			listenSocketPath,
			snapshotDir,
			encryptionKey,
			workloadsDir,
			managePodman: true,
		});
	} catch (err) {
		console.error("Failed to start boilerhouse-podmand:", err instanceof Error ? err.message : err);
		process.exit(1);
	}

	console.log(`boilerhouse-podmand listening on ${listenSocketPath}`);
	console.log(`  podman socket: ${podmanSocketPath} (managed)`);
	console.log(`  snapshot dir:  ${snapshotDir}`);

	process.on("SIGTERM", () => {
		console.log("Received SIGTERM, shutting down...");
		daemon.stop();
		process.exit(0);
	});

	process.on("SIGINT", () => {
		console.log("Received SIGINT, shutting down...");
		daemon.stop();
		process.exit(0);
	});
}
