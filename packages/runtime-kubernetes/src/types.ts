/** Options shared by all K8s auth modes. */
interface KubernetesCommonConfig {
	/**
	 * Namespace for all managed pods.
	 * @default "boilerhouse"
	 */
	namespace?: string;

	/**
	 * Directory for storing snapshot data (overlay tars + workload JSON).
	 * Only required if snapshot/restore is used.
	 * @example "/var/lib/boilerhouse/snapshots"
	 */
	snapshotDir?: string;

	/**
	 * kubectl context name. Used for exec operations which shell out to kubectl.
	 * @example "boilerhouse-test"
	 */
	context?: string;

	/**
	 * Minikube profile name. When set, enables `minikube image build` for
	 * Dockerfile-based workloads and `minikube image pull` for registry images.
	 * @default Same as context
	 * @example "boilerhouse-test"
	 */
	minikubeProfile?: string;

	/**
	 * Base directory for resolving workload Dockerfile paths.
	 * @example "/home/user/project/workloads"
	 */
	workloadsDir?: string;
}

/** Explicit API URL + bearer token (minikube, external clusters). */
export interface KubernetesExternalConfig extends KubernetesCommonConfig {
	auth: "external";

	/**
	 * K8s API server URL.
	 * @example "https://192.168.49.2:8443"
	 */
	apiUrl: string;

	/**
	 * Bearer token for API authentication.
	 * @example "eyJhbGciOiJSUzI1NiIs..."
	 */
	token: string;

	/**
	 * PEM-encoded CA certificate for the API server.
	 * When omitted, TLS verification is disabled (suitable for minikube/dev).
	 */
	caCert?: string;
}

/**
 * Auto-detected from the service account mounted into every K8s pod.
 * Reads token from `/var/run/secrets/kubernetes.io/serviceaccount/token`
 * and CA from `/var/run/secrets/kubernetes.io/serviceaccount/ca.crt`.
 */
export interface KubernetesInClusterConfig extends KubernetesCommonConfig {
	auth: "in-cluster";
}

export type KubernetesConfig = KubernetesExternalConfig | KubernetesInClusterConfig;

// ── Minimal K8s API types ───────────────────────────────────────────────────

export interface K8sObjectMeta {
	name: string;
	namespace?: string;
	labels?: Record<string, string>;
	annotations?: Record<string, string>;
}

export interface K8sContainer {
	name: string;
	image: string;
	imagePullPolicy?: "Always" | "IfNotPresent" | "Never";
	command?: string[];
	args?: string[];
	env?: Array<{ name: string; value: string }>;
	ports?: Array<{ containerPort: number; protocol?: string }>;
	resources?: {
		limits?: Record<string, string>;
		requests?: Record<string, string>;
	};
	readinessProbe?: K8sProbe;
	workingDir?: string;
	volumeMounts?: Array<{ name: string; mountPath: string }>;
}

export interface K8sProbe {
	httpGet?: { path: string; port: number };
	exec?: { command: string[] };
	periodSeconds?: number;
	failureThreshold?: number;
	timeoutSeconds?: number;
}

export interface K8sVolume {
	name: string;
	emptyDir?: { sizeLimit?: string };
}

export interface K8sPodSpec {
	containers: K8sContainer[];
	restartPolicy?: "Always" | "OnFailure" | "Never";
	volumes?: K8sVolume[];
}

export interface K8sPod {
	apiVersion: "v1";
	kind: "Pod";
	metadata: K8sObjectMeta;
	spec: K8sPodSpec;
	status?: K8sPodStatus;
}

export interface K8sPodStatus {
	phase?: string;
	podIP?: string;
	containerStatuses?: Array<{
		name: string;
		ready: boolean;
		state: {
			running?: { startedAt: string };
			waiting?: { reason: string; message?: string };
			terminated?: { exitCode: number; reason?: string };
		};
	}>;
}

export interface K8sPodList {
	apiVersion: "v1";
	kind: "PodList";
	items: K8sPod[];
}

export interface K8sService {
	apiVersion: "v1";
	kind: "Service";
	metadata: K8sObjectMeta;
	spec: {
		selector: Record<string, string>;
		ports: Array<{
			name?: string;
			port: number;
			targetPort: number;
			protocol?: string;
		}>;
		type?: string;
	};
}

export interface K8sStatus {
	kind: "Status";
	apiVersion: "v1";
	status: "Success" | "Failure";
	message?: string;
	reason?: string;
	code: number;
}

export interface K8sNamespace {
	apiVersion: "v1";
	kind: "Namespace";
	metadata: K8sObjectMeta;
	status?: { phase?: string };
}
