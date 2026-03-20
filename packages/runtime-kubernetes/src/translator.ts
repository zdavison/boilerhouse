import type { Workload } from "@boilerhouse/core";
import type { InstanceId } from "@boilerhouse/core";
import type { K8sPod, K8sService, K8sContainer, K8sVolume, K8sProbe, K8sNetworkPolicy } from "./types";

export const MANAGED_LABEL = "boilerhouse.dev/managed";
export const INSTANCE_ID_LABEL = "boilerhouse.dev/instance-id";
export const WORKLOAD_NAME_LABEL = "boilerhouse.dev/workload-name";

export const ENVOY_IMAGE = "docker.io/envoyproxy/envoy:v1.32-latest";
export const ENVOY_PROXY_PORT = 18080;

export interface TranslationResult {
	pod: K8sPod;
	service?: K8sService;
	networkPolicy?: K8sNetworkPolicy;
}

/**
 * Translates a Boilerhouse {@link Workload} into K8s Pod (and optional Service) specs.
 *
 * Mapping:
 * - `image.ref` → container image
 * - `resources` → resource limits
 * - `network.expose` → container ports + Service
 * - `entrypoint` → command/args/env
 * - `filesystem.overlay_dirs` → emptyDir volumes
 * - `health` → readinessProbe
 */
/**
 * @param imageOverride Resolved image ref, used when the workload was built from a Dockerfile.
 * @param proxyConfig When provided, adds an Envoy sidecar container and HTTP_PROXY env vars.
 */
export function workloadToPod(
	workload: Workload,
	instanceId: InstanceId,
	namespace: string,
	imageOverride?: string,
	proxyConfig?: string,
): TranslationResult {
	const labels: Record<string, string> = {
		[MANAGED_LABEL]: "true",
		[INSTANCE_ID_LABEL]: instanceId,
		[WORKLOAD_NAME_LABEL]: workload.workload.name,
	};

	const imageRef = imageOverride ?? workload.image.ref;
	if (!imageRef) {
		throw new Error(
			`Workload "${workload.workload.name}" has no image ref and no imageOverride was provided`,
		);
	}

	const container: K8sContainer = {
		name: "main",
		image: imageRef,
	};

	// Resources
	container.resources = {
		limits: {
			cpu: `${workload.resources.vcpus * 1000}m`,
			memory: `${workload.resources.memory_mb}Mi`,
		},
		requests: {
			cpu: `${Math.max(100, Math.floor(workload.resources.vcpus * 250))}m`,
			memory: `${Math.min(workload.resources.memory_mb, 128)}Mi`,
		},
	};

	// Entrypoint
	if (workload.entrypoint) {
		if (workload.entrypoint.cmd) {
			container.command = [workload.entrypoint.cmd];
		}
		if (workload.entrypoint.args) {
			container.args = workload.entrypoint.args;
		}
		if (workload.entrypoint.env) {
			container.env = Object.entries(workload.entrypoint.env).map(
				([name, value]) => ({ name, value }),
			);
		}
		if (workload.entrypoint.workdir) {
			container.workingDir = workload.entrypoint.workdir;
		}
	}

	// Ports
	const exposePorts = workload.network?.expose;
	if (exposePorts && exposePorts.length > 0) {
		container.ports = exposePorts.map((p) => ({
			containerPort: p.guest,
			protocol: "TCP",
		}));
	}

	// Health check → readinessProbe
	if (workload.health) {
		const probe: K8sProbe = {
			periodSeconds: workload.health.interval_seconds,
			failureThreshold: workload.health.unhealthy_threshold,
		};
		if (workload.health.check_timeout_seconds) {
			probe.timeoutSeconds = workload.health.check_timeout_seconds;
		}

		if (workload.health.http_get) {
			probe.httpGet = {
				path: workload.health.http_get.path,
				port: workload.health.http_get.port ?? (exposePorts?.[0]?.guest ?? 8080),
			};
		} else if (workload.health.exec) {
			probe.exec = { command: workload.health.exec.command };
		}

		container.readinessProbe = probe;
	}

	// Volumes from overlay_dirs
	const volumes: K8sVolume[] = [];
	const volumeMounts: Array<{ name: string; mountPath: string }> = [];

	if (workload.filesystem?.overlay_dirs) {
		for (let i = 0; i < workload.filesystem.overlay_dirs.length; i++) {
			const dir = workload.filesystem.overlay_dirs[i]!;
			const name = `overlay-${i}`;
			volumes.push({ name, emptyDir: { sizeLimit: "256Mi" } });
			volumeMounts.push({ name, mountPath: dir });
		}
	}

	if (volumeMounts.length > 0) {
		container.volumeMounts = volumeMounts;
	}

	// Envoy sidecar injection
	const containers: K8sContainer[] = [container];

	if (proxyConfig) {
		// Inject HTTP_PROXY env vars on the main container
		container.env ??= [];
		container.env.push(
			{ name: "HTTP_PROXY", value: `http://localhost:${ENVOY_PROXY_PORT}` },
			{ name: "http_proxy", value: `http://localhost:${ENVOY_PROXY_PORT}` },
		);

		// Add proxy config volume
		volumes.push({ name: "proxy-config", configMap: { name: `${instanceId}-proxy` } });

		// Add Envoy sidecar container
		containers.push({
			name: "proxy",
			image: ENVOY_IMAGE,
			command: ["envoy", "-c", "/etc/envoy/envoy.yaml", "--log-level", "warn"],
			ports: [{ containerPort: ENVOY_PROXY_PORT }],
			volumeMounts: [{ name: "proxy-config", mountPath: "/etc/envoy" }],
			resources: {
				limits: { cpu: "100m", memory: "64Mi" },
				requests: { cpu: "50m", memory: "32Mi" },
			},
		});
	}

	const pod: K8sPod = {
		apiVersion: "v1",
		kind: "Pod",
		metadata: {
			name: instanceId,
			namespace,
			labels,
		},
		spec: {
			containers,
			restartPolicy: "Never",
			...(volumes.length > 0 ? { volumes } : {}),
		},
	};

	// Service for exposed ports.
	// Service names must be valid DNS-1035 labels (start with a letter),
	// but instance IDs are UUIDs that may start with a digit. Prefix with "svc-".
	let service: K8sService | undefined;
	if (exposePorts && exposePorts.length > 0) {
		service = {
			apiVersion: "v1",
			kind: "Service",
			metadata: {
				name: `svc-${instanceId}`,
				namespace,
				labels,
			},
			spec: {
				selector: { [INSTANCE_ID_LABEL]: instanceId },
				ports: exposePorts.map((p, i) => ({
					port: p.guest,
					targetPort: p.guest,
					protocol: "TCP",
					...(exposePorts.length > 1 ? { name: `port-${i}` } : {}),
				})),
				type: "ClusterIP",
			},
		};
	}

	// NetworkPolicy: restrict egress to DNS + HTTPS when sidecar is active
	let networkPolicy: K8sNetworkPolicy | undefined;
	if (proxyConfig) {
		networkPolicy = {
			apiVersion: "networking.k8s.io/v1",
			kind: "NetworkPolicy",
			metadata: {
				name: `${instanceId}-restrict`,
				namespace,
				labels,
			},
			spec: {
				podSelector: { matchLabels: { [INSTANCE_ID_LABEL]: instanceId } },
				policyTypes: ["Egress"],
				egress: [
					{
						ports: [
							{ protocol: "UDP", port: 53 },
							{ protocol: "TCP", port: 53 },
						],
						to: [{ namespaceSelector: {} }],
					},
					{
						ports: [{ protocol: "TCP", port: 443 }],
					},
				],
			},
		};
	}

	return { pod, service, networkPolicy };
}
