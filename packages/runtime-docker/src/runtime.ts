import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { InstanceId } from "@boilerhouse/core";
import type { Workload } from "@boilerhouse/core";
import type { Runtime, InstanceHandle, Endpoint, ExecResult, CreateOptions, ImageResolver } from "@boilerhouse/core";
import type { DockerConfig } from "./types";
import { DockerClient } from "./client";
import type { ContainerCreateBody } from "./client";
import { DockerRuntimeError } from "./errors";
import { HARDENED_CAP_ADD } from "./hardening";
import { resolveTemplates, assertNoSecretRefs } from "./templates";
import { DockerSidecar } from "./sidecar";
import type { SidecarState } from "./sidecar";
import { DockerImageResolver } from "./image-resolver";

interface ManagedInstance {
	instanceId: InstanceId;
	running: boolean;
	/** Host ports resolved after start. */
	ports: number[];
	/** Whether this instance has an Envoy proxy sidecar. */
	hasSidecar: boolean;
	/** Sidecar state for cleanup. Only present when hasSidecar is true. */
	sidecarState?: SidecarState;
	/** Mapping from container overlay dir → host dir backing the bind mount. */
	overlayDirMap?: Map<string, string>;
}

export class DockerRuntime implements Runtime {
	private readonly instances = new Map<string, ManagedInstance>();
	private readonly client: DockerClient;
	private readonly sidecar: DockerSidecar;
	private readonly imageResolver: ImageResolver;
	private readonly seccompProfilePath?: string;

	constructor(config: DockerConfig = {}) {
		this.client = new DockerClient({ socketPath: config.socketPath });
		this.sidecar = new DockerSidecar(this.client);
		this.imageResolver = new DockerImageResolver(this.client);
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
		const proxyCaCert = options?.proxyCaCert;
		const proxyCerts = options?.proxyCerts;

		// 1. Ensure the workload image is available
		const { imageRef } = await this.imageResolver.ensure(workload.image, workload.workload, log);

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

		// 4. Determine if a sidecar is needed
		const hasSidecar = !!(proxyConfig && workload.network.access !== "none");

		// 5. Resolve env templates and block secret refs
		const rawEnv = workload.entrypoint?.env ?? {};
		const resolvedEnv = resolveTemplates(rawEnv);
		assertNoSecretRefs(resolvedEnv);

		// If MITM TLS is enabled, prepare CA cert for the workload container
		let caCertPath: string | undefined;
		const extraBinds: string[] = [];
		if (hasSidecar && proxyCaCert) {
			const ca = this.sidecar.prepareCaCert(instanceId, proxyCaCert);
			caCertPath = ca.caCertPath;
			extraBinds.push(...ca.binds);
			for (const [k, v] of Object.entries(ca.env)) {
				resolvedEnv[k] ??= v;
			}
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

		// overlay_dirs backed by host directories (persist across exec, visible before entrypoint)
		let overlayDirMap: Map<string, string> | undefined;
		if (workload.filesystem?.overlay_dirs) {
			overlayDirMap = new Map();
			spec.HostConfig.Binds = spec.HostConfig.Binds ?? [];
			for (const dir of workload.filesystem.overlay_dirs) {
				const hostDir = mkdtempSync(join(tmpdir(), `boilerhouse-${instanceId}-overlay-`));
				overlayDirMap.set(dir, hostDir);
				spec.HostConfig.Binds.push(`${hostDir}:${dir}`);
			}
		}

		// Mount extra binds (CA cert, etc.)
		if (extraBinds.length > 0) {
			spec.HostConfig.Binds = [...(spec.HostConfig.Binds ?? []), ...extraBinds];
		}

		// 7. Create workload container
		await this.client.createContainer(instanceId, spec);

		// 8. Create sidecar if needed
		let sidecarState: SidecarState | undefined;
		if (hasSidecar) {
			sidecarState = await this.sidecar.create(instanceId, {
				proxyConfig: proxyConfig!,
				proxyCaCert,
				proxyCerts,
			});
			if (caCertPath) sidecarState.caCertPath = caCertPath;
			log("Envoy sidecar proxy created");
		}

		this.instances.set(instanceId, {
			instanceId,
			running: false,
			ports: [],
			hasSidecar,
			sidecarState,
			overlayDirMap,
		});

		return { instanceId, running: false };
	}

	async start(handle: InstanceHandle): Promise<void> {
		const instance = this.requireInstance(handle.instanceId);

		await this.client.startContainer(handle.instanceId);

		if (instance.hasSidecar) {
			await this.sidecar.start(handle.instanceId);
		}

		instance.running = true;
		handle.running = true;
	}

	async destroy(handle: InstanceHandle): Promise<void> {
		const instance = this.instances.get(handle.instanceId);

		// Remove sidecar first (it depends on the workload container's network namespace)
		if (instance?.hasSidecar && instance.sidecarState) {
			await this.sidecar.destroy(handle.instanceId, instance.sidecarState);
		}

		await this.client.removeContainer(handle.instanceId);

		// Clean up overlay host directories
		if (instance?.overlayDirMap) {
			for (const dir of instance.overlayDirMap.values()) {
				try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ }
			}
		}

		this.instances.delete(handle.instanceId);
		handle.running = false;
	}

	async exec(handle: InstanceHandle, command: string[], options?: import("@boilerhouse/core").ExecOptions): Promise<ExecResult> {
		if (options?.stdin) {
			const chunks: Buffer[] = [];
			for await (const chunk of options.stdin) {
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
			}
			return this.client.execWithStdin(handle.instanceId, command, Buffer.concat(chunks));
		}
		return this.client.exec(handle.instanceId, command);
	}

	async injectArchive(instanceId: InstanceId, destPath: string, tar: Buffer): Promise<void> {
		const instance = this.instances.get(instanceId);

		// When overlay dirs are bind-mounted, putArchive writes to the container
		// layer which gets shadowed by the bind mount at start. Extract overlay
		// portions directly into the host dirs backing the bind mounts instead.
		if (instance?.overlayDirMap?.size) {
			const tmp = mkdtempSync(join(tmpdir(), `boilerhouse-inject-`));
			try {
				const tarPath = join(tmp, "overlay.tar.gz");
				writeFileSync(tarPath, tar);
				const staging = join(tmp, "staging");
				await Bun.$`mkdir -p ${staging} && tar -xzf ${tarPath} -C ${staging}`.quiet();
				for (const [containerDir, hostDir] of instance.overlayDirMap) {
					const relDir = containerDir.replace(/^\//, "");
					const stagedDir = join(staging, relDir);
					await Bun.$`test -d ${stagedDir} && cp -a ${stagedDir}/. ${hostDir}/ || true`.quiet();
				}
			} finally {
				rmSync(tmp, { recursive: true, force: true });
			}
			return;
		}

		await this.client.putArchive(instanceId as string, destPath, tar);
	}

	async pause(handle: InstanceHandle): Promise<void> {
		await this.client.pauseContainer(handle.instanceId as string);
	}

	async unpause(handle: InstanceHandle): Promise<void> {
		await this.client.unpauseContainer(handle.instanceId as string);
	}

	async extractOverlayArchive(instanceId: InstanceId, overlayDirs: string[]): Promise<Buffer | null> {
		const instance = this.instances.get(instanceId);
		if (!instance?.overlayDirMap?.size || overlayDirs.length === 0) return null;

		const tmp = mkdtempSync(join(tmpdir(), `boilerhouse-extract-`));
		try {
			const staging = join(tmp, "staging");
			for (const [containerDir, hostDir] of instance.overlayDirMap) {
				if (!overlayDirs.includes(containerDir)) continue;
				const relDir = containerDir.replace(/^\//, "");
				const linkTarget = join(staging, relDir);
				await Bun.$`mkdir -p ${join(staging, dirname(relDir))}`.quiet();
				await Bun.$`ln -s ${hostDir} ${linkTarget}`.quiet();
			}

			const tarPath = join(tmp, "overlay.tar.gz");
			await Bun.$`tar -czh -f ${tarPath} -C ${staging} .`.quiet();
			return Buffer.from(readFileSync(tarPath));
		} finally {
			rmSync(tmp, { recursive: true, force: true });
		}
	}

	async restart(handle: InstanceHandle): Promise<void> {
		await this.client.restartContainer(handle.instanceId as string);
		const instance = this.instances.get(handle.instanceId);
		if (instance) instance.ports = [];
	}

	async statOverlayDirs(instanceId: InstanceId, handle: InstanceHandle, dirs: string[]): Promise<Date | null> {
		if (dirs.length === 0) return null;
		const dirArgs = dirs.map((d) => `'${d}'`).join(" ");
		const result = await this.exec(handle, [
			"sh", "-c",
			`find ${dirArgs} -maxdepth 3 2>/dev/null | xargs -r stat -c '%Y' 2>/dev/null | sort -rn | head -1`,
		]);
		if (result.exitCode !== 0) return null;
		if (!result.stdout.trim()) return new Date(0);
		const seconds = parseInt(result.stdout.trim(), 10);
		if (isNaN(seconds)) return null;
		return new Date(seconds * 1000);
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
		const names = await this.client.listContainers();
		return names as InstanceId[];
	}

	async logs(handle: InstanceHandle, tail = 100): Promise<string | null> {
		try {
			return await this.client.containerLogs(handle.instanceId, tail);
		} catch {
			return null;
		}
	}

	async stats(handle: InstanceHandle): Promise<import("@boilerhouse/core").ContainerResourceStats | null> {
		try {
			const s = await this.client.containerStats(handle.instanceId);
			const cpuDelta = s.cpu_stats.cpu_usage.total_usage - s.precpu_stats.cpu_usage.total_usage;
			const sysDelta = s.cpu_stats.system_cpu_usage - s.precpu_stats.system_cpu_usage;
			const cpuFraction = sysDelta > 0 ? (cpuDelta / sysDelta) * s.cpu_stats.online_cpus : 0;
			return {
				cpuFraction,
				memoryBytes: s.memory_stats.usage ?? 0,
				memoryLimitBytes: s.memory_stats.limit ?? 0,
			};
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

}
