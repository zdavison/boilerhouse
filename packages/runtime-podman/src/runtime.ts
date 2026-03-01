import { resolve, dirname, basename, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import type { InstanceId } from "@boilerhouse/core";
import { generateSnapshotId, generateWorkloadId, generateNodeId } from "@boilerhouse/core";
import type { SnapshotRef, SnapshotPaths, SnapshotMetadata } from "@boilerhouse/core";
import type { Workload } from "@boilerhouse/core";
import type { Runtime, InstanceHandle, Endpoint, ExecResult } from "@boilerhouse/core";
import type { PodmanConfig } from "./types";
import { PodmanRuntimeError } from "./errors";
import { PodmanClient } from "./client";
import type { ContainerCreateSpec } from "./client";

const DEFAULT_SOCKET_PATH = "/run/boilerhouse/podman.sock";

/**
 * Resolves `${VAR}` references in env values from the host process environment.
 * Unresolved references are replaced with an empty string.
 */
export function resolveEnvVars(env: Record<string, string>): Record<string, string> {
	const resolved: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		resolved[key] = value.replace(/\$\{(\w+)\}/g, (_, name: string) => process.env[name] ?? "");
	}
	return resolved;
}

interface ManagedContainer {
	instanceId: InstanceId;
	running: boolean;
	/** Published host ports (resolved after start or restore). */
	ports: number[];
}

export class PodmanRuntime implements Runtime {
	private readonly containers = new Map<string, ManagedContainer>();
	private readonly snapshotDir: string;
	private readonly workloadsDir: string | undefined;
	private readonly client: PodmanClient;

	constructor(config: PodmanConfig) {
		this.snapshotDir = config.snapshotDir;
		this.workloadsDir = config.workloadsDir;
		this.client = new PodmanClient({
			socketPath: config.socketPath ?? DEFAULT_SOCKET_PATH,
		});
	}

	async available(): Promise<boolean> {
		try {
			const info = await this.client.info();
			return info.host.criuEnabled;
		} catch {
			return false;
		}
	}

	async create(workload: Workload, instanceId: InstanceId): Promise<InstanceHandle> {
		const imageRef = await this.ensureImage(workload);

		// Build container create spec
		const spec: ContainerCreateSpec = {
			name: instanceId,
			image: imageRef,
			labels: {
				"boilerhouse.workload": workload.workload.name,
				"boilerhouse.version": workload.workload.version,
			},
			resource_limits: {
				cpu: {
					quota: workload.resources.vcpus * 100_000,
					period: 100_000,
				},
				memory: {
					limit: workload.resources.memory_mb * 1024 * 1024,
				},
			},
		};

		// Network mode — "none" means no network namespace at all (no port mappings possible)
		if (workload.network.access === "none") {
			spec.netns = { nsmode: "none" };
		} else {
			// Port mappings only make sense when a network namespace exists
			const exposePorts = workload.network.expose;
			if (exposePorts && exposePorts.length > 0) {
				spec.portmappings = exposePorts.map((mapping) => ({
					container_port: mapping.guest,
					host_port: 0,
					protocol: "tcp",
				}));
			} else {
				// Default: expose port 8080
				spec.portmappings = [{ container_port: 8080, host_port: 0, protocol: "tcp" }];
			}
		}

		// Mount overlay_dirs as tmpfs so CRIU can checkpoint inode handles
		if (workload.filesystem?.overlay_dirs) {
			spec.mounts = workload.filesystem.overlay_dirs.map((dir) => ({
				destination: dir,
				type: "tmpfs" as const,
				options: ["size=256m", "mode=1777"],
			}));
		}

		// Entrypoint overrides
		if (workload.entrypoint) {
			if (workload.entrypoint.cmd) {
				spec.entrypoint = [workload.entrypoint.cmd];
			}
			if (workload.entrypoint.args) {
				spec.command = workload.entrypoint.args;
			}
			if (workload.entrypoint.env) {
				spec.env = resolveEnvVars(workload.entrypoint.env);
			}
			if (workload.entrypoint.workdir) {
				spec.work_dir = workload.entrypoint.workdir;
			}
		}

		await this.client.createContainer(spec);

		this.containers.set(instanceId, {
			instanceId,
			running: false,
			ports: [],
		});

		return { instanceId, running: false };
	}

	async start(handle: InstanceHandle): Promise<void> {
		await this.client.startContainer(handle.instanceId);

		const container = this.requireContainer(handle.instanceId);
		container.running = true;
		handle.running = true;

		// Resolve published host ports
		container.ports = await this.resolveHostPorts(handle.instanceId);
	}

	async destroy(handle: InstanceHandle): Promise<void> {
		// Force remove — idempotent (ignores 404)
		await this.client.removeContainer(handle.instanceId, true);
		this.containers.delete(handle.instanceId);
		handle.running = false;
	}

	async snapshot(handle: InstanceHandle): Promise<SnapshotRef> {
		const container = this.requireContainer(handle.instanceId);
		const snapshotId = generateSnapshotId();

		const archiveDir = `${this.snapshotDir}/${snapshotId}`;
		try {
			await Bun.$`mkdir -p ${archiveDir}`.quiet();
		} catch {
			throw new PodmanRuntimeError(
				`Cannot create snapshot directory ${archiveDir} — check that ${this.snapshotDir} exists and is writable`,
			);
		}

		const archivePath = `${archiveDir}/checkpoint.tar.gz`;

		// Wait for all established TCP connections to close before CRIU checkpoint.
		// CRIU cannot restore TCP connections when the container's IP changes on restore.
		await this.waitForTcpDrain(handle.instanceId);

		// Checkpoint streams the archive as the response body
		const archiveBuffer = await this.client.checkpointContainer(handle.instanceId);

		// Container is stopped after checkpoint
		container.running = false;
		handle.running = false;

		// Rewrite the archive to zero out baked-in host ports.
		// Without this, restoring the same snapshot twice would fail because
		// both containers try to bind the same host port.
		const { archive: rewrittenArchive, containerPorts } =
			await rewriteCheckpointPorts(archiveBuffer);

		await Bun.write(archivePath, rewrittenArchive);

		const info = await this.client.info();
		const architecture = await this.getArchitecture();

		const paths: SnapshotPaths = {
			memory: archivePath,
			vmstate: archivePath,
		};

		const runtimeMeta: SnapshotMetadata = {
			runtimeVersion: info.version.Version,
			architecture,
			exposedPorts: containerPorts.length > 0 ? containerPorts : undefined,
		};

		return {
			id: snapshotId,
			type: "tenant",
			paths,
			workloadId: generateWorkloadId(),
			nodeId: generateNodeId(),
			runtimeMeta,
		};
	}

	async restore(ref: SnapshotRef, instanceId: InstanceId): Promise<InstanceHandle> {
		// The archive was already rewritten at snapshot time to have hostPort=0,
		// which prevents "address already in use" conflicts on restore.
		// We also pass publishPorts so podman sets up fresh port forwarding.
		const archiveData = await Bun.file(ref.paths.vmstate).arrayBuffer();
		const archive = Buffer.from(archiveData);

		// Build publishPorts specs from the snapshot's exposed container ports.
		// Just the container port number — podman picks a random host port.
		const containerPorts = ref.runtimeMeta?.exposedPorts;
		const publishPorts = containerPorts?.map((p) => String(p));

		await this.client.restoreContainer(archive, instanceId, publishPorts);

		const ports = await this.resolveHostPorts(instanceId);

		this.containers.set(instanceId, {
			instanceId,
			running: true,
			ports,
		});

		return { instanceId, running: true };
	}

	async exec(handle: InstanceHandle, command: string[]): Promise<ExecResult> {
		const execId = await this.client.execCreate(handle.instanceId, command);
		return this.client.execStart(execId);
	}

	async getEndpoint(handle: InstanceHandle): Promise<Endpoint> {
		const container = this.containers.get(handle.instanceId);
		let ports = container?.ports;

		if (!ports || ports.length === 0) {
			ports = await this.resolveHostPorts(handle.instanceId);
			if (container) {
				container.ports = ports;
			}
		}

		if (ports.length === 0) {
			return { host: "127.0.0.1", ports: [] };
		}

		return { host: "127.0.0.1", ports };
	}

	async list(): Promise<InstanceId[]> {
		return Array.from(this.containers.keys()) as InstanceId[];
	}

	// ── Private helpers ──────────────────────────────────────────────────────

	/**
	 * Ensure the workload's image is available locally.
	 *
	 * - If `image.ref` is set, pull from registry if not cached.
	 * - If `image.dockerfile` is set, build from the Dockerfile (requires
	 *   `workloadsDir` in config). The built image is tagged as
	 *   `boilerhouse/<name>:<version>`.
	 *
	 * Returns the image reference to use for container creation.
	 */
	private async ensureImage(workload: Workload): Promise<string> {
		if (workload.image.ref) {
			const exists = await this.client.imageExists(workload.image.ref);
			if (!exists) {
				await this.client.pullImage(workload.image.ref);
			}
			return workload.image.ref;
		}

		if (workload.image.dockerfile) {
			if (!this.workloadsDir) {
				throw new PodmanRuntimeError(
					"Workload uses image.dockerfile but PodmanConfig.workloadsDir is not set",
				);
			}

			const tag = `boilerhouse/${workload.workload.name}:${workload.workload.version}`;

			// Skip build if image already exists
			const exists = await this.client.imageExists(tag);
			if (exists) {
				return tag;
			}

			const dockerfilePath = resolve(this.workloadsDir, workload.image.dockerfile);
			const contextDir = dirname(dockerfilePath);
			const dockerfileName = basename(dockerfilePath);

			// Create a tar archive of the build context
			const proc = Bun.spawn(["tar", "-cf", "-", "-C", contextDir, "."], {
				stdout: "pipe",
				stderr: "pipe",
			});

			const [tarData, tarErr] = await Promise.all([
				new Response(proc.stdout).arrayBuffer(),
				new Response(proc.stderr).text(),
			]);
			const exitCode = await proc.exited;

			if (exitCode !== 0) {
				throw new PodmanRuntimeError(
					`Failed to create build context tar: ${tarErr.trim()}`,
				);
			}

			await this.client.buildImage(
				Buffer.from(tarData),
				tag,
				dockerfileName,
			);

			return tag;
		}

		throw new PodmanRuntimeError(
			"Workload must have either image.ref or image.dockerfile set",
		);
	}

	/**
	 * Wait for all established TCP connections inside the container to close.
	 *
	 * CRIU cannot checkpoint established TCP connections without
	 * `--tcp-established`. Rather than adding that flag and dealing with
	 * stale connections on restore, we drain them before checkpoint.
	 *
	 * Reads `/proc/net/tcp` via `cat` and parses the output in TypeScript.
	 * State `01` = TCP_ESTABLISHED.
	 *
	 * If the exec fails (e.g. no network namespace, or `/proc/net/tcp`
	 * doesn't exist), we treat it as "no connections" and return immediately.
	 *
	 * @param maxWaitMs - Maximum time to wait for connections to drain.
	 *   @default 30000
	 * @param pollIntervalMs - Time between polls.
	 *   @default 1000
	 */
	private async waitForTcpDrain(
		instanceId: string,
		maxWaitMs = 30_000,
		pollIntervalMs = 1_000,
	): Promise<void> {
		const deadline = Date.now() + maxWaitMs;

		while (Date.now() < deadline) {
			let result: { exitCode: number; stdout: string };
			try {
				const execId = await this.client.execCreate(instanceId, [
					"cat", "/proc/net/tcp",
				]);
				result = await this.client.execStart(execId);
			} catch {
				// Exec failed entirely (container stopped, no network namespace, etc.)
				return;
			}

			if (result.exitCode !== 0) {
				// cat failed — /proc/net/tcp doesn't exist (no network namespace)
				return;
			}

			if (!hasEstablishedConnections(result.stdout)) {
				return;
			}

			await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
		}

		throw new PodmanRuntimeError(
			`TCP connections in container ${instanceId} did not drain within ${maxWaitMs}ms`,
		);
	}

	private requireContainer(instanceId: InstanceId): ManagedContainer {
		const container = this.containers.get(instanceId);
		if (!container) {
			throw new PodmanRuntimeError(`Container not tracked: ${instanceId}`);
		}
		return container;
	}

	/**
	 * Resolve published host ports by inspecting the container.
	 * Parses NetworkSettings.Ports from the inspect response.
	 */
	private async resolveHostPorts(instanceId: string): Promise<number[]> {
		try {
			const inspect = await this.client.inspectContainer(instanceId);
			const portsMap = inspect.NetworkSettings?.Ports;
			if (!portsMap) return [];

			const ports: number[] = [];
			for (const bindings of Object.values(portsMap)) {
				if (!bindings) continue;
				for (const binding of bindings) {
					const port = Number(binding.HostPort);
					if (port > 0) {
						ports.push(port);
					}
				}
			}
			return ports;
		} catch {
			return [];
		}
	}

	private async getArchitecture(): Promise<string> {
		const proc = Bun.spawn(["uname", "-m"], { stdout: "pipe" });
		const stdout = await new Response(proc.stdout).text();
		await proc.exited;
		return stdout.trim() || "unknown";
	}
}

// ── /proc/net/tcp parsing ───────────────────────────────────────────────────

/**
 * Parses the output of `cat /proc/net/tcp` and returns `true` if any
 * connection is in ESTABLISHED state (state code `01`).
 *
 * /proc/net/tcp format (whitespace-separated columns):
 *   sl  local_address  rem_address  st  ...
 * The state field is the 4th column (index 3). `01` = TCP_ESTABLISHED.
 */
export function hasEstablishedConnections(procNetTcp: string): boolean {
	const lines = procNetTcp.split("\n").slice(1); // skip header
	for (const line of lines) {
		const fields = line.trim().split(/\s+/);
		if (fields[3] === "01") return true;
	}
	return false;
}

// ── Checkpoint archive rewriting ────────────────────────────────────────────

/** Port mapping entry as stored in a podman checkpoint's `config.dump`. */
interface CheckpointPortMapping {
	container_port: number;
	host_port: number;
	host_ip?: string;
	range?: number;
	protocol?: string;
}

/**
 * Rewrites a CRIU checkpoint tar.gz archive to zero out baked-in host ports
 * in `config.dump`. This forces podman to assign fresh random host ports on
 * each restore, preventing "address already in use" conflicts.
 *
 * Also extracts the container ports from the archive so they can be stored
 * in snapshot metadata.
 *
 * @returns The modified archive and the container ports found in config.dump.
 */
export async function rewriteCheckpointPorts(
	archive: Buffer,
): Promise<{ archive: Buffer; containerPorts: number[] }> {
	const tmpDir = mkdtempSync(join(tmpdir(), "bh-checkpoint-rewrite-"));
	try {
		const archivePath = join(tmpDir, "checkpoint.tar.gz");
		const extractDir = join(tmpDir, "extracted");

		await Bun.write(archivePath, archive);
		await Bun.$`mkdir -p ${extractDir}`.quiet();

		// Detect if archive is gzip-compressed (magic bytes 0x1f 0x8b)
		const isGzip = archive.length >= 2 && archive[0] === 0x1f && archive[1] === 0x8b;
		const tarFlags = isGzip ? "-xzf" : "-xf";

		// --no-same-owner / --no-same-permissions: the checkpoint archive is
		// created by rootful podman and may contain root-owned entries that
		// fail to extract as a regular user.
		await Bun.$`tar ${tarFlags} ${archivePath} -C ${extractDir} --no-same-owner --no-same-permissions`.quiet();

		// Read and modify config.dump
		const configPath = join(extractDir, "config.dump");
		const configFile = Bun.file(configPath);

		if (!(await configFile.exists())) {
			// No config.dump means no port mappings to rewrite
			return { archive, containerPorts: [] };
		}

		const config = (await configFile.json()) as Record<string, unknown>;
		const portMappings = config.newPortMappings as CheckpointPortMapping[] | undefined;

		if (!portMappings || portMappings.length === 0) {
			return { archive, containerPorts: [] };
		}

		// Extract container ports, then zero out host ports
		const containerPorts: number[] = [];
		for (const mapping of portMappings) {
			if (mapping.container_port > 0) {
				containerPorts.push(mapping.container_port);
			}
			mapping.host_port = 0;
		}

		await Bun.write(configPath, JSON.stringify(config));

		// Re-archive in the same format as the original
		const repackFlags = isGzip ? "-czf" : "-cf";
		const modifiedPath = join(tmpDir, "modified.tar.gz");
		await Bun.$`tar ${repackFlags} ${modifiedPath} -C ${extractDir} .`.quiet();

		const modifiedData = await Bun.file(modifiedPath).arrayBuffer();
		return { archive: Buffer.from(modifiedData), containerPorts };
	} finally {
		await Bun.$`rm -rf ${tmpDir}`.quiet().nothrow();
	}
}
