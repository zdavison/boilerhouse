import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { generateSnapshotId, generateWorkloadId, generateNodeId } from "@boilerhouse/core";
import type {
	Runtime,
	RuntimeCapabilities,
	InstanceHandle,
	Endpoint,
	ExecResult,
	CreateOptions,
	SnapshotRef,
	SnapshotPaths,
	SnapshotMetadata,
	Workload,
	InstanceId,
} from "@boilerhouse/core";
import type { KubernetesConfig } from "./types";
import { KubeClient } from "./client";
import { workloadToPod, MANAGED_LABEL, ENVOY_IMAGE } from "./translator";
import { KubernetesRuntimeError } from "./errors";
import { MinikubeImageProvider } from "./minikube";
import type { EnsureImageResult } from "./minikube";
import { isInCluster, resolveInClusterConfig } from "./in-cluster";

/**
 * Tracks a managed pod and its associated workload (needed for restore).
 */
interface ManagedPod {
	instanceId: InstanceId;
	running: boolean;
	workload: Workload;
	/** Active port-forward processes, keyed by container port. */
	portForwards: Map<number, { proc: ReturnType<typeof Bun.spawn>; localPort: number }>;
}

export class KubernetesRuntime implements Runtime {
	readonly capabilities: RuntimeCapabilities = { goldenSnapshots: false };

	private readonly client: KubeClient;
	private readonly namespace: string;
	private readonly snapshotDir: string | undefined;
	private readonly context: string | undefined;
	private readonly imageProvider: MinikubeImageProvider | undefined;
	private readonly pods = new Map<string, ManagedPod>();

	constructor(config: KubernetesConfig) {
		if (config.auth === "in-cluster") {
			const inCluster = resolveInClusterConfig();
			this.client = new KubeClient({
				apiUrl: inCluster.apiUrl,
				token: inCluster.token,
				caCert: inCluster.caCert,
			});
			this.namespace = config.namespace ?? inCluster.namespace;
		} else {
			this.client = new KubeClient({
				apiUrl: config.apiUrl,
				token: config.token,
				caCert: config.caCert,
			});
			this.namespace = config.namespace ?? "boilerhouse";
		}

		this.snapshotDir = config.snapshotDir;
		this.context = config.context;

		const minikubeProfile = config.minikubeProfile ?? config.context;
		if (minikubeProfile) {
			this.imageProvider = new MinikubeImageProvider(minikubeProfile, config.workloadsDir);
		}
	}

	async available(): Promise<boolean> {
		try {
			// List pods in namespace to check connectivity and permissions.
			// Avoids needing cluster-level namespace read permission.
			await this.client.listPods(this.namespace, `${MANAGED_LABEL}=true`);
			return true;
		} catch {
			return false;
		}
	}

	async create(
		workload: Workload,
		instanceId: InstanceId,
		options?: CreateOptions,
	): Promise<InstanceHandle> {
		const log = options?.onLog ?? (() => {});
		const proxyConfig = options?.proxyConfig;

		const { imageRef, localBuild } = await this.ensureImage(workload, log);

		// Ensure the Envoy image is available in minikube
		if (proxyConfig && this.imageProvider) {
			await this.imageProvider.ensureImage(
				{ ref: ENVOY_IMAGE },
				{ name: "envoy-proxy", version: "sidecar" },
				log,
			);
		}

		log(`Creating pod ${instanceId} (image: ${imageRef})...`);

		const { pod, service, networkPolicy } = workloadToPod(
			workload, instanceId, this.namespace, imageRef, proxyConfig,
		);

		// Locally-built images (via minikube) aren't in a registry —
		// prevent K8s from trying to pull them.
		if (localBuild) {
			pod.spec.containers[0]!.imagePullPolicy = "Never";
		}

		// Create ConfigMap for proxy config before the pod (pod references it as a volume)
		if (proxyConfig) {
			await this.client.createConfigMap(this.namespace, {
				apiVersion: "v1",
				kind: "ConfigMap",
				metadata: { name: `${instanceId}-proxy`, namespace: this.namespace },
				data: { "envoy.yaml": proxyConfig },
			});
		}

		await this.client.createPod(this.namespace, pod);

		if (service) {
			try {
				await this.client.createService(this.namespace, service);
			} catch (err) {
				// Clean up pod + configmap if service creation fails
				await this.client.deletePod(this.namespace, instanceId).catch(() => {});
				if (proxyConfig) {
					await this.client.deleteConfigMap(this.namespace, `${instanceId}-proxy`).catch(() => {});
				}
				throw err;
			}
		}

		if (networkPolicy) {
			await this.client.createNetworkPolicy(this.namespace, networkPolicy).catch(() => {});
		}

		this.pods.set(instanceId, { instanceId, running: false, workload, portForwards: new Map() });

		log(`Pod ${instanceId} created`);
		return { instanceId, running: false };
	}

	async start(handle: InstanceHandle): Promise<void> {
		// In K8s, pods start automatically after creation.
		// "start" means waiting for the pod to reach Running phase.
		try {
			await this.client.waitForPodRunning(this.namespace, handle.instanceId);
		} catch (err) {
			// Clean up the pod if it fails to start (e.g. bad image).
			await this.destroy(handle).catch(() => {});
			throw err;
		}

		const managed = this.pods.get(handle.instanceId);
		if (managed) managed.running = true;
		handle.running = true;
	}

	async destroy(handle: InstanceHandle): Promise<void> {
		// Kill any port-forward processes
		const managed = this.pods.get(handle.instanceId);
		if (managed) {
			for (const { proc } of managed.portForwards.values()) {
				proc.kill();
			}
		}

		// Delete pod and service (idempotent, ignore 404)
		await Promise.all([
			this.client.deletePod(this.namespace, handle.instanceId),
			this.client.deleteService(this.namespace, `svc-${handle.instanceId}`),
			// ConfigMap and NetworkPolicy are optional (only exist for proxy pods).
			// Swallow all errors — these are best-effort cleanup and must never
			// block pod destruction (e.g. if RBAC doesn't include configmaps yet).
			this.client.deleteConfigMap(this.namespace, `${handle.instanceId}-proxy`).catch(() => {}),
			this.client.deleteNetworkPolicy(this.namespace, `${handle.instanceId}-restrict`).catch(() => {}),
		]);

		// Wait for pod to actually be deleted
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			try {
				await this.client.getPod(this.namespace, handle.instanceId);
				await new Promise((r) => setTimeout(r, 500));
			} catch (err) {
				if (err instanceof KubernetesRuntimeError && err.statusCode === 404) {
					break;
				}
				throw err;
			}
		}

		this.pods.delete(handle.instanceId);
		handle.running = false;
	}

	async snapshot(handle: InstanceHandle): Promise<SnapshotRef> {
		if (!this.snapshotDir) {
			throw new KubernetesRuntimeError("snapshotDir is required for snapshot operations");
		}

		const managed = this.pods.get(handle.instanceId);
		if (!managed) {
			throw new KubernetesRuntimeError(`Pod not tracked: ${handle.instanceId}`);
		}

		const snapshotId = generateSnapshotId();
		const archiveDir = join(this.snapshotDir, snapshotId);
		mkdirSync(archiveDir, { recursive: true, mode: 0o700 });

		// Save workload definition for later restore
		writeFileSync(
			join(archiveDir, "workload.json"),
			JSON.stringify(managed.workload),
		);

		// Tar overlay directories from the container
		const overlayDirs = managed.workload.filesystem?.overlay_dirs;
		if (overlayDirs && overlayDirs.length > 0) {
			const tarCmd = ["tar", "czf", "-", ...overlayDirs];
			const result = await this.client.exec(
				this.namespace,
				handle.instanceId,
				["sh", "-c", `${tarCmd.join(" ")} | base64`],
				this.context,
			);

			if (result.exitCode === 0 && result.stdout.trim()) {
				const tarData = Buffer.from(result.stdout.trim(), "base64");
				writeFileSync(join(archiveDir, "overlay.tar.gz"), tarData);
			}
		}

		const overlayPath = join(archiveDir, "overlay.tar.gz");

		const paths: SnapshotPaths = {
			memory: overlayPath,
			vmstate: overlayPath,
		};

		const runtimeMeta: SnapshotMetadata = {
			runtimeVersion: "kubernetes",
			architecture: process.arch === "x64" ? "x86_64" : process.arch,
			exposedPorts: managed.workload.network?.expose?.map((p) => p.guest),
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

	async restore(ref: SnapshotRef, instanceId: InstanceId, options?: CreateOptions): Promise<InstanceHandle> {
		const proxyConfig = options?.proxyConfig;

		// Read workload.json from the snapshot directory
		const snapshotDir = join(ref.paths.memory, "..");
		const workloadPath = join(snapshotDir, "workload.json");

		let workload: Workload;
		try {
			workload = JSON.parse(readFileSync(workloadPath, "utf-8")) as Workload;
		} catch {
			throw new KubernetesRuntimeError(
				`Cannot read workload.json from snapshot directory: ${snapshotDir}`,
			);
		}

		// Ensure image is available and create pod
		const { imageRef, localBuild } = await this.ensureImage(workload, () => {});

		if (proxyConfig && this.imageProvider) {
			await this.imageProvider.ensureImage(
				{ ref: ENVOY_IMAGE },
				{ name: "envoy-proxy", version: "sidecar" },
				() => {},
			);
		}

		const { pod, service, networkPolicy } = workloadToPod(
			workload, instanceId, this.namespace, imageRef, proxyConfig,
		);
		if (localBuild) {
			pod.spec.containers[0]!.imagePullPolicy = "Never";
		}

		// Create ConfigMap before pod
		if (proxyConfig) {
			await this.client.createConfigMap(this.namespace, {
				apiVersion: "v1",
				kind: "ConfigMap",
				metadata: { name: `${instanceId}-proxy`, namespace: this.namespace },
				data: { "envoy.yaml": proxyConfig },
			});
		}

		await this.client.createPod(this.namespace, pod);

		if (service) {
			await this.client.createService(this.namespace, service).catch(() => {});
		}

		if (networkPolicy) {
			await this.client.createNetworkPolicy(this.namespace, networkPolicy).catch(() => {});
		}

		// Wait for pod to be running
		await this.client.waitForPodRunning(this.namespace, instanceId);

		// Restore overlay data if present
		const overlayPath = join(snapshotDir, "overlay.tar.gz");
		try {
			const overlayData = readFileSync(overlayPath);
			if (overlayData.length > 0) {
				const b64 = overlayData.toString("base64");
				await this.client.exec(
					this.namespace,
					instanceId,
					["sh", "-c", `echo '${b64}' | base64 -d | tar xzf - -C /`],
					this.context,
				);
			}
		} catch {
			// No overlay data to restore
		}

		this.pods.set(instanceId, { instanceId, running: true, workload, portForwards: new Map() });
		return { instanceId, running: true };
	}

	async exec(handle: InstanceHandle, command: string[]): Promise<ExecResult> {
		return this.client.exec(this.namespace, handle.instanceId, command, this.context);
	}

	async getEndpoint(handle: InstanceHandle): Promise<Endpoint> {
		const managed = this.pods.get(handle.instanceId);
		const pod = await this.client.getPod(this.namespace, handle.instanceId);
		const podIp = pod.status?.podIP;

		const containerPorts: number[] = [];
		for (const c of pod.spec?.containers ?? []) {
			if (c.ports) {
				for (const p of c.ports) {
					containerPorts.push(p.containerPort);
				}
			}
		}

		if (containerPorts.length === 0) {
			return { host: podIp ?? "127.0.0.1", ports: [] };
		}

		// When kubectl context is available, use port-forwarding so pod IPs
		// don't need to be routable from the host (e.g. minikube + docker driver).
		if (this.context) {
			const localPorts: number[] = [];
			for (const cp of containerPorts) {
				const existing = managed?.portForwards.get(cp);
				if (existing) {
					localPorts.push(existing.localPort);
					continue;
				}

				const localPort = await this.startPortForward(handle.instanceId, cp);
				await this.waitForPortReady(localPort);
				localPorts.push(localPort);
			}

			return { host: "127.0.0.1", ports: localPorts };
		}

		// Without a kubectl context, return pod IP directly (works when
		// the pod network is routable from the host).
		return { host: podIp ?? "127.0.0.1", ports: containerPorts };
	}

	/**
	 * Starts `kubectl port-forward` on a random local port and returns the assigned port.
	 */
	private async startPortForward(podName: string, containerPort: number): Promise<number> {
		const args = ["kubectl"];
		if (this.context) args.push("--context", this.context);
		args.push("-n", this.namespace, "port-forward", `pod/${podName}`, `:${containerPort}`);

		const proc = Bun.spawn(args, {
			stdout: "pipe",
			stderr: "pipe",
		});

		// Read stdout to discover the assigned local port.
		// kubectl prints: "Forwarding from 127.0.0.1:XXXXX -> containerPort"
		const reader = proc.stdout.getReader();
		const deadline = Date.now() + 10_000;
		let accumulated = "";

		while (Date.now() < deadline) {
			const { value, done } = await reader.read();
			if (done) break;
			accumulated += new TextDecoder().decode(value);

			const match = accumulated.match(/Forwarding from 127\.0\.0\.1:(\d+)/);
			if (match) {
				const localPort = Number(match[1]);
				// Release the reader so port-forward keeps running
				reader.releaseLock();

				const managed = this.pods.get(podName);
				if (managed) {
					managed.portForwards.set(containerPort, { proc, localPort });
				}

				return localPort;
			}
		}

		proc.kill();
		throw new KubernetesRuntimeError(
			`kubectl port-forward did not produce a local port within 10s (output: ${accumulated.slice(0, 200)})`,
		);
	}

	/**
	 * Waits until a local TCP port accepts connections.
	 * Uses raw TCP connect to avoid HTTP-level issues.
	 */
	private async waitForPortReady(port: number, timeoutMs = 30_000): Promise<void> {
		const { connect } = await import("node:net");
		const deadline = Date.now() + timeoutMs;

		while (Date.now() < deadline) {
			const ok = await new Promise<boolean>((resolve) => {
				const sock = connect(port, "127.0.0.1", () => {
					sock.destroy();
					resolve(true);
				});
				sock.on("error", () => {
					sock.destroy();
					resolve(false);
				});
				sock.setTimeout(1000, () => {
					sock.destroy();
					resolve(false);
				});
			});
			if (ok) return;
			await new Promise((r) => setTimeout(r, 500));
		}
	}

	// ── Image management ───────────────────────────────────────────────────

	/**
	 * Ensures the workload image is available to the cluster.
	 *
	 * With a minikube image provider, images are pulled/built into minikube's
	 * container runtime. Without one, `image.ref` is passed through (K8s pulls
	 * from the registry), and `image.dockerfile` is rejected with an error.
	 */
	private async ensureImage(
		workload: Workload,
		log: (line: string) => void,
	): Promise<EnsureImageResult> {
		if (this.imageProvider) {
			return this.imageProvider.ensureImage(workload.image, workload.workload, log);
		}

		// No image provider — only registry refs are supported
		if (workload.image.ref) {
			return { imageRef: workload.image.ref, localBuild: false };
		}

		throw new KubernetesRuntimeError(
			`Workload "${workload.workload.name}" uses a Dockerfile, but no minikube profile is configured. ` +
			`Either set minikubeProfile for local dev, or build and push the image to a registry and use image.ref instead.`,
		);
	}

	async list(): Promise<InstanceId[]> {
		const podList = await this.client.listPods(
			this.namespace,
			`${MANAGED_LABEL}=true`,
		);

		return podList.items.map(
			(p) => p.metadata.name as InstanceId,
		);
	}

	async logs(handle: InstanceHandle, tail = 100): Promise<string | null> {
		try {
			return await this.client.getPodLogs(this.namespace, handle.instanceId, tail);
		} catch {
			return null;
		}
	}
}
