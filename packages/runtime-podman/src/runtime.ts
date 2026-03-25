import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trace, SpanStatusCode } from "@opentelemetry/api";
import type { InstanceId } from "@boilerhouse/core";
import { DEFAULT_RUNTIME_SOCKET } from "@boilerhouse/core";
import type { Workload } from "@boilerhouse/core";
import type { Runtime, InstanceHandle, Endpoint, ExecResult, CreateOptions } from "@boilerhouse/core";
import type { PodmanConfig } from "./types";
import type { ContainerBackend } from "./backend";
import { PodmanRuntimeError } from "./errors";
import type { ContainerCreateSpec } from "./client";
import { resolveTemplates, assertNoSecretRefs } from "./templates";
import { DaemonBackend } from "./daemon-backend";
import { HARDENED_CAP_ADD } from "./hardening";

/** Envoy sidecar image used for per-instance proxy containers. */
const ENVOY_IMAGE = "docker.io/envoyproxy/envoy:v1.32-latest";
const ENVOY_PROXY_PORT = 18080;

interface ManagedInstance {
	instanceId: InstanceId;
	running: boolean;
	/** Published host ports (resolved after start or restore). */
	ports: number[];
	/** Whether this instance has an Envoy proxy sidecar for network restriction. */
	hasEnvoyProxySidecar: boolean;
}

export class PodmanRuntime implements Runtime {
	private readonly instances = new Map<string, ManagedInstance>();
	private readonly snapshotDir: string;
	private readonly backend: ContainerBackend;
	private readonly seccompProfilePath?: string;

	constructor(config: PodmanConfig) {
		this.snapshotDir = config.snapshotDir;
		this.seccompProfilePath = config.seccompProfilePath;
		this.backend = new DaemonBackend({ socketPath: config.socketPath ?? DEFAULT_RUNTIME_SOCKET });
	}

	async available(): Promise<boolean> {
		try {
			const info = await this.backend.info();
			return info.criuEnabled;
		} catch {
			return false;
		}
	}

	async create(workload: Workload, instanceId: InstanceId, options?: CreateOptions): Promise<InstanceHandle> {
		const log = options?.onLog ?? (() => {});
		const proxyConfig = options?.proxyConfig;

		const imageSource = workload.image.dockerfile
			? `Dockerfile ${workload.image.dockerfile}`
			: workload.image.ref ?? "unknown";
		log(`Ensuring image (${imageSource})...`);

		const { image: imageRef, action } = await this.backend.ensureImage(
			workload.image,
			workload.workload,
		);

		if (action === "built") {
			log(`Image built: ${imageRef}`);
		} else if (action === "pulled") {
			log(`Image pulled: ${imageRef}`);
		} else {
			log(`Image cached: ${imageRef}`);
		}

		// Determine port mappings
		let portmappings: Array<{ container_port: number; host_port: number; protocol: string }> | undefined;
		if (workload.network.access !== "none") {
			const exposePorts = workload.network.expose;
			if (exposePorts && exposePorts.length > 0) {
				portmappings = exposePorts.map((mapping) => ({
					container_port: mapping.guest,
					host_port: 0,
					protocol: "tcp",
				}));
			} else {
				portmappings = [{ container_port: 8080, host_port: 0, protocol: "tcp" }];
			}
		}

		// Security assertion: no fixed host ports
		if (portmappings) {
			for (const pm of portmappings) {
				if (pm.host_port !== 0) {
					throw new PodmanRuntimeError(
						`Fixed host port ${pm.host_port} is not allowed — use host_port: 0 for ephemeral allocation`,
					);
				}
			}
		}

		const hasEnvoyProxySidecar = !!proxyConfig;

		// Always create a podman pod — containers share the pod's network namespace
		const { hostPorts: podHostPorts } = await this.backend.createPod(instanceId, {
			portmappings,
			netns: workload.network.access === "none" ? { nsmode: "none" } : undefined,
		});

		// Add Envoy sidecar if proxy config is provided
		if (proxyConfig) {
			await this.backend.ensureImage({ ref: ENVOY_IMAGE }, { name: "envoy-proxy", version: "sidecar" });

			const configPath = await this.backend.writeFile(
				`${instanceId}-envoy.yaml`,
				proxyConfig,
			);

			await this.backend.createContainer({
				name: `${instanceId}-proxy`,
				image: ENVOY_IMAGE,
				pod: instanceId,
				command: ["envoy", "-c", "/etc/envoy/envoy.yaml", "--log-level", "warn"],
				privileged: false,
				cap_drop: ["ALL"],
				no_new_privileges: true,
				mounts: [{
					destination: "/etc/envoy/envoy.yaml",
					type: "bind",
					source: configPath,
					options: ["ro"],
				}],
			});

			log("Envoy sidecar proxy created");
		}

		// Build workload container spec
		const spec: ContainerCreateSpec = {
			name: instanceId,
			image: imageRef,
			pod: instanceId,
			privileged: false,
			cap_drop: ["ALL"],
			cap_add: HARDENED_CAP_ADD,
			...(this.seccompProfilePath ? { seccomp_profile_path: this.seccompProfilePath } : {}),
			no_new_privileges: true,
			pidns: { nsmode: "private" },
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
			storage_opt: { size: `${workload.resources.disk_gb ?? 2}G` },
		};

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
				const resolved = resolveTemplates(workload.entrypoint.env);
				assertNoSecretRefs(resolved);
				spec.env = resolved;
			}
			if (workload.entrypoint.workdir) {
				spec.work_dir = workload.entrypoint.workdir;
			}
		}

		// Inject HTTP_PROXY pointing to the sidecar on localhost
		if (hasEnvoyProxySidecar && workload.network.access !== "none") {
			spec.env ??= {};
			spec.env.HTTP_PROXY ??= `http://localhost:${ENVOY_PROXY_PORT}`;
			spec.env.http_proxy ??= `http://localhost:${ENVOY_PROXY_PORT}`;
		}

		await this.backend.createContainer(spec);

		this.instances.set(instanceId, {
			instanceId,
			running: false,
			ports: podHostPorts,
			hasEnvoyProxySidecar,
		});

		return { instanceId, running: false };
	}

	async start(handle: InstanceHandle): Promise<void> {
		const instance = this.requireInstance(handle.instanceId);

		await this.backend.startPod(handle.instanceId);

		instance.running = true;
		handle.running = true;
	}

	async destroy(handle: InstanceHandle): Promise<void> {
		const instance = this.instances.get(handle.instanceId);

		// Delete the pod — removes all containers (infra, proxy, workload)
		await this.backend.removePod(handle.instanceId);

		if (instance?.hasEnvoyProxySidecar) {
			await this.backend.removeFile(`${handle.instanceId}-envoy.yaml`);
		}

		this.instances.delete(handle.instanceId);
		handle.running = false;
	}

	async exec(handle: InstanceHandle, command: string[]): Promise<ExecResult> {
		return this.backend.exec(handle.instanceId, command);
	}

	async getEndpoint(handle: InstanceHandle): Promise<Endpoint> {
		const instance = this.instances.get(handle.instanceId);
		let ports = instance?.ports;

		if (!ports || ports.length === 0) {
			ports = await this.resolveHostPorts(handle.instanceId);
			if (instance) {
				instance.ports = ports;
			}
		}

		if (ports.length === 0) {
			return { host: "127.0.0.1", ports: [] };
		}

		return { host: "127.0.0.1", ports };
	}

	async list(): Promise<InstanceId[]> {
		const names = await this.backend.listPods();
		return names as InstanceId[];
	}

	async logs(handle: InstanceHandle, tail = 100): Promise<string | null> {
		try {
			return await this.backend.logs(handle.instanceId, tail);
		} catch {
			return null;
		}
	}

	// ── Private helpers ──────────────────────────────────────────────────────
	private requireInstance(instanceId: InstanceId): ManagedInstance {
		const instance = this.instances.get(instanceId);
		if (!instance) {
			throw new PodmanRuntimeError(`Instance not tracked: ${instanceId}`);
		}
		return instance;
	}

	/**
	 * Resolve published host ports by inspecting the pod's infra container.
	 *
	 * In a podman pod, port mappings belong to the infra container (which
	 * owns the shared network namespace), not the workload container.
	 */
	private async resolveHostPorts(instanceId: string): Promise<number[]> {
		try {
			const pod = await this.backend.inspectPod(instanceId);
			if (!pod.infraContainerId) return [];

			const inspect = await this.backend.inspectContainer(pod.infraContainerId);
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
