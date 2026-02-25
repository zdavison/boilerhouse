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

interface ManagedContainer {
	instanceId: InstanceId;
	running: boolean;
	/** Published host ports (resolved after start or restore). */
	ports: number[];
}

export class PodmanRuntime implements Runtime {
	private readonly containers = new Map<string, ManagedContainer>();
	private readonly snapshotDir: string;
	private readonly client: PodmanClient;

	constructor(config: PodmanConfig) {
		this.snapshotDir = config.snapshotDir;
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
		const imageRef = workload.image.ref;
		if (!imageRef) {
			throw new PodmanRuntimeError("Workload must have image.ref set");
		}

		// Pull image if not already present
		const exists = await this.client.imageExists(imageRef);
		if (!exists) {
			await this.client.pullImage(imageRef);
		}

		// Build container create spec
		const spec: ContainerCreateSpec = {
			name: instanceId,
			image: imageRef,
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

		// Network mode
		if (workload.network.access === "none") {
			spec.netns = { nsmode: "none" };
		}

		// Port mappings
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

		// Entrypoint overrides
		if (workload.entrypoint) {
			if (workload.entrypoint.cmd) {
				spec.entrypoint = [workload.entrypoint.cmd];
			}
			if (workload.entrypoint.args) {
				spec.command = workload.entrypoint.args;
			}
			if (workload.entrypoint.env) {
				spec.env = workload.entrypoint.env;
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
		await Bun.$`mkdir -p ${archiveDir}`.quiet();

		const archivePath = `${archiveDir}/checkpoint.tar.gz`;

		// Checkpoint streams the archive as the response body
		const archiveBuffer = await this.client.checkpointContainer(handle.instanceId);
		await Bun.write(archivePath, archiveBuffer);

		// Container is stopped after checkpoint
		container.running = false;
		handle.running = false;

		const info = await this.client.info();
		const architecture = await this.getArchitecture();

		const paths: SnapshotPaths = {
			memory: archivePath,
			vmstate: archivePath,
		};

		const runtimeMeta: SnapshotMetadata = {
			runtimeVersion: info.version.Version,
			architecture,
			exposedPorts: container.ports.length > 0 ? container.ports : undefined,
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
		// Read archive from disk and POST to the API
		const archiveData = await Bun.file(ref.paths.vmstate).arrayBuffer();
		const archive = Buffer.from(archiveData);

		await this.client.restoreContainer(archive, instanceId);

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
			throw new PodmanRuntimeError(
				`No published ports for container ${handle.instanceId}`,
			);
		}

		return { host: "127.0.0.1", ports };
	}

	async list(): Promise<InstanceId[]> {
		return Array.from(this.containers.keys()) as InstanceId[];
	}

	// ── Private helpers ──────────────────────────────────────────────────────

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
