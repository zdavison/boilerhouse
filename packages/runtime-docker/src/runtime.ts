import { mkdtempSync, writeFileSync, unlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";
import type { InstanceId } from "@boilerhouse/core";
import type { Workload } from "@boilerhouse/core";
import type { Runtime, InstanceHandle, Endpoint, ExecResult, CreateOptions } from "@boilerhouse/core";
import type { DockerConfig } from "./types";
import { DockerClient } from "./client";
import type { ContainerCreateBody } from "./client";
import { DockerRuntimeError } from "./errors";
import { HARDENED_CAP_ADD } from "./hardening";
import { resolveTemplates, assertNoSecretRefs } from "./templates";

/** Envoy sidecar image for per-instance network proxy containers. */
const ENVOY_IMAGE = "docker.io/envoyproxy/envoy:v1.32-latest";
const ENVOY_PROXY_PORT = 18080;

interface ManagedInstance {
	instanceId: InstanceId;
	running: boolean;
	/** Host ports resolved after start. */
	ports: number[];
	/** Whether this instance has an Envoy proxy sidecar. */
	hasSidecar: boolean;
	/** Path to the Envoy config file on the host, if a sidecar was created. */
	sidecarConfigPath?: string;
}

export class DockerRuntime implements Runtime {
	private readonly instances = new Map<string, ManagedInstance>();
	private readonly client: DockerClient;
	private readonly seccompProfilePath?: string;

	constructor(config: DockerConfig = {}) {
		this.client = new DockerClient({ socketPath: config.socketPath });
		this.seccompProfilePath = config.seccompProfilePath;
	}

	async available(): Promise<boolean> {
		return this.client.ping();
	}

	async create(
		workload: Workload,
		instanceId: InstanceId,
		options?: CreateOptions,
	): Promise<InstanceHandle> {
		const log = options?.onLog ?? (() => {});
		const proxyConfig = options?.proxyConfig;

		// 1. Ensure the workload image is available
		const { imageRef, action } = await this.ensureImage(workload, log);
		if (action === "built") {
			log(`Image built: ${imageRef}`);
		} else if (action === "pulled") {
			log(`Image pulled: ${imageRef}`);
		} else {
			log(`Image cached: ${imageRef}`);
		}

		// 2. Port bindings — only when the network is not fully isolated
		let portBindings: Record<string, Array<{ HostPort: string }>> | undefined;
		let exposedPorts: Record<string, Record<string, never>> | undefined;

		if (workload.network.access !== "none") {
			const exposePorts = workload.network.expose;
			const ports =
				exposePorts && exposePorts.length > 0
					? exposePorts.map((m) => m.guest)
					: [8080];

			portBindings = {};
			exposedPorts = {};
			for (const port of ports) {
				const key = `${port}/tcp`;
				portBindings[key] = [{ HostPort: "0" }];
				exposedPorts[key] = {};
			}
		}

		// 3. Security options
		const securityOpt: string[] = ["no-new-privileges:true"];
		if (this.seccompProfilePath) {
			const profile = readFileSync(this.seccompProfilePath, "utf-8");
			securityOpt.push(`seccomp=${profile}`);
		}

		// 4. Determine if a sidecar is needed and inject HTTP_PROXY env
		const hasSidecar = !!(proxyConfig && workload.network.access !== "none");

		// 5. Resolve env templates and block secret refs
		const rawEnv = workload.entrypoint?.env ?? {};
		const resolvedEnv = resolveTemplates(rawEnv);
		assertNoSecretRefs(resolvedEnv);

		if (hasSidecar) {
			resolvedEnv.HTTP_PROXY ??= `http://localhost:${ENVOY_PROXY_PORT}`;
			resolvedEnv.http_proxy ??= `http://localhost:${ENVOY_PROXY_PORT}`;
		}

		const envList = Object.entries(resolvedEnv).map(([k, v]) => `${k}=${v}`);

		// 6. Build workload container spec
		const spec: ContainerCreateBody = {
			Image: imageRef,
			Labels: {
				"boilerhouse.managed": "true",
				"boilerhouse.role": "workload",
				"boilerhouse.workload": workload.workload.name,
				"boilerhouse.version": workload.workload.version,
			},
			ExposedPorts: exposedPorts,
			HostConfig: {
				CapDrop: ["ALL"],
				CapAdd: HARDENED_CAP_ADD,
				SecurityOpt: securityOpt,
				PidMode: "private",
				NetworkMode: workload.network.access === "none" ? "none" : "bridge",
				PortBindings: portBindings,
				Resources: {
					CpuQuota: workload.resources.vcpus * 100_000,
					CpuPeriod: 100_000,
					Memory: workload.resources.memory_mb * 1024 * 1024,
				},
			},
		};

		if (workload.entrypoint?.cmd) spec.Entrypoint = [workload.entrypoint.cmd];
		if (workload.entrypoint?.args) spec.Cmd = workload.entrypoint.args;
		if (envList.length > 0) spec.Env = envList;
		if (workload.entrypoint?.workdir) spec.WorkingDir = workload.entrypoint.workdir;

		// overlay_dirs mounted as tmpfs (writable ephemeral directories)
		if (workload.filesystem?.overlay_dirs) {
			spec.HostConfig.Tmpfs = Object.fromEntries(
				workload.filesystem.overlay_dirs.map((dir) => [dir, "size=256m,mode=1777"]),
			);
		}

		// 7. Create workload container
		await this.client.createContainer(instanceId, spec);

		// 8. Create Envoy sidecar if needed
		let sidecarConfigPath: string | undefined;
		if (hasSidecar) {
			sidecarConfigPath = join(tmpdir(), `boilerhouse-${instanceId}-envoy.yaml`);
			writeFileSync(sidecarConfigPath, proxyConfig!);

			await this.client.createContainer(`${instanceId}-proxy`, {
				Image: ENVOY_IMAGE,
				Cmd: ["envoy", "-c", "/etc/envoy/envoy.yaml", "--log-level", "warn"],
				Labels: {
					"boilerhouse.managed": "true",
					"boilerhouse.role": "proxy",
				},
				HostConfig: {
					CapDrop: ["ALL"],
					SecurityOpt: ["no-new-privileges:true"],
					// Share the workload container's network namespace so
					// localhost:18080 is reachable from the workload process.
					NetworkMode: `container:${instanceId}`,
					Binds: [`${sidecarConfigPath}:/etc/envoy/envoy.yaml:ro`],
				},
			});

			log("Envoy sidecar proxy created");
		}

		this.instances.set(instanceId, {
			instanceId,
			running: false,
			ports: [],
			hasSidecar,
			sidecarConfigPath,
		});

		return { instanceId, running: false };
	}

	async start(handle: InstanceHandle): Promise<void> {
		const instance = this.requireInstance(handle.instanceId);

		await this.client.startContainer(handle.instanceId);

		// The sidecar requires the workload container to be running first
		// since it shares its network namespace.
		if (instance.hasSidecar) {
			await this.client.startContainer(`${handle.instanceId}-proxy`);
		}

		instance.running = true;
		handle.running = true;
	}

	async destroy(handle: InstanceHandle): Promise<void> {
		const instance = this.instances.get(handle.instanceId);

		// Remove sidecar first (it depends on the workload container's network namespace)
		if (instance?.hasSidecar) {
			await this.client.removeContainer(`${handle.instanceId}-proxy`);
			if (instance.sidecarConfigPath) {
				try {
					unlinkSync(instance.sidecarConfigPath);
				} catch {
					// Best-effort
				}
			}
		}

		await this.client.removeContainer(handle.instanceId);

		this.instances.delete(handle.instanceId);
		handle.running = false;
	}

	async exec(handle: InstanceHandle, command: string[]): Promise<ExecResult> {
		return this.client.exec(handle.instanceId, command);
	}

	async getEndpoint(handle: InstanceHandle): Promise<Endpoint> {
		const instance = this.instances.get(handle.instanceId);
		let ports = instance?.ports;

		if (!ports || ports.length === 0) {
			ports = await this.resolveHostPorts(handle.instanceId);
			if (instance) instance.ports = ports;
		}

		return { host: "127.0.0.1", ports };
	}

	async list(): Promise<InstanceId[]> {
		return Array.from(this.instances.keys()) as InstanceId[];
	}

	async logs(handle: InstanceHandle, tail = 100): Promise<string | null> {
		try {
			return await this.client.containerLogs(handle.instanceId, tail);
		} catch {
			return null;
		}
	}

	// ── Private helpers ──────────────────────────────────────────────────────

	private requireInstance(instanceId: InstanceId): ManagedInstance {
		const instance = this.instances.get(instanceId);
		if (!instance) {
			throw new DockerRuntimeError(`Instance not tracked: ${instanceId}`);
		}
		return instance;
	}

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
					if (port > 0) ports.push(port);
				}
			}
			return ports;
		} catch {
			return [];
		}
	}

	/**
	 * Ensure the workload image is present locally. Pulls from a registry or
	 * builds from a Dockerfile as appropriate.
	 */
	private async ensureImage(
		workload: Workload,
		log: (line: string) => void,
	): Promise<{ imageRef: string; action: "cached" | "pulled" | "built" }> {
		if (workload.image.dockerfile) {
			const dockerfilePath = resolve(workload.image.dockerfile);
			const contextDir = dirname(dockerfilePath);
			const dockerfileRelPath = basename(dockerfilePath);
			const tag = `boilerhouse/${workload.workload.name}:${workload.workload.version}`;

			if (await this.client.imageExists(tag)) {
				return { imageRef: tag, action: "cached" };
			}

			log(`Building image from ${dockerfileRelPath}...`);
			const tar = await this.createContextTar(contextDir);
			await this.client.buildImage(tar, tag, dockerfileRelPath);
			return { imageRef: tag, action: "built" };
		}

		const ref = workload.image.ref!;
		if (await this.client.imageExists(ref)) {
			return { imageRef: ref, action: "cached" };
		}

		log(`Pulling image ${ref}...`);
		await this.client.pullImage(ref);
		return { imageRef: ref, action: "pulled" };
	}

	/** Create a tar archive of a directory for use as a Docker build context. */
	private async createContextTar(contextDir: string): Promise<Buffer> {
		const tmpDir = mkdtempSync(join(tmpdir(), "bh-docker-build-"));
		const tarPath = join(tmpDir, "context.tar");
		try {
			await Bun.$`tar -cf ${tarPath} -C ${contextDir} .`.quiet();
			const data = await Bun.file(tarPath).arrayBuffer();
			return Buffer.from(data);
		} finally {
			await Bun.$`rm -rf ${tmpDir}`.quiet().nothrow();
		}
	}
}
