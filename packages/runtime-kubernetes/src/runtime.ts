import type {
	Runtime,
	InstanceHandle,
	Endpoint,
	ExecResult,
	CreateOptions,
	Workload,
	InstanceId,
	ImageResolver,
	ImageResolveResult,
} from "@boilerhouse/core";
import type { KubernetesConfig } from "./types";
import { KubeClient } from "./client";
import { workloadToPod, MANAGED_LABEL, ENVOY_IMAGE } from "./translator";
import { KubernetesRuntimeError } from "./errors";
import { MinikubeImageProvider } from "./minikube";
import { resolveInClusterConfig } from "./in-cluster";

interface ManagedPod {
	instanceId: InstanceId;
	running: boolean;
	/** Active port-forward processes, keyed by container port. */
	portForwards: Map<number, { proc: ReturnType<typeof Bun.spawn>; localPort: number }>;
}

export class KubernetesRuntime implements Runtime {
	private readonly client: KubeClient;
	private readonly namespace: string;
	private readonly context: string | undefined;
	private readonly imageResolver: ImageResolver | undefined;
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

		this.context = config.context;

		const minikubeProfile = config.minikubeProfile ?? config.context;
		if (minikubeProfile) {
			this.imageResolver = new MinikubeImageProvider(minikubeProfile, config.workloadsDir);
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
		if (proxyConfig && this.imageResolver) {
			await this.imageResolver.ensure(
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

		this.pods.set(instanceId, { instanceId, running: false, portForwards: new Map() });

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
	): Promise<ImageResolveResult> {
		if (this.imageResolver) {
			return this.imageResolver.ensure(workload.image, workload.workload, log);
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

	async extractOverlayArchive(instanceId: InstanceId, overlayDirs: string[]): Promise<Buffer | null> {
		if (overlayDirs.length === 0) return null;
		const handle: InstanceHandle = { instanceId, running: true };
		const dirArgs = overlayDirs.map((d) => `'${d}'`).join(" ");
		const result = await this.exec(handle, [
			"sh", "-c", `tar czf - ${dirArgs} 2>/dev/null | base64`,
		]);
		if (result.exitCode !== 0 || !result.stdout.trim()) return null;
		return Buffer.from(result.stdout.trim(), "base64");
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
}
