import type {
	K8sPod,
	K8sPodList,
	K8sService,
	K8sStatus,
	K8sNamespace,
	K8sConfigMap,
	K8sNetworkPolicy,
} from "./types";
import { KubernetesRuntimeError } from "./errors";

export interface KubeClientConfig {
	/** K8s API server URL (e.g. "https://192.168.49.2:8443") */
	apiUrl: string;
	/** Bearer token */
	token: string;
	/** PEM-encoded CA cert, or undefined to disable TLS verification */
	caCert?: string;
}

export class KubeClient {
	private readonly apiUrl: string;
	private readonly token: string;
	private readonly tlsOptions: { rejectUnauthorized: boolean; ca?: string };

	constructor(config: KubeClientConfig) {
		this.apiUrl = config.apiUrl.replace(/\/$/, "");
		this.token = config.token;
		this.tlsOptions = config.caCert
			? { rejectUnauthorized: true, ca: config.caCert }
			: { rejectUnauthorized: false };
	}

	// ── Pod operations ──────────────────────────────────────────────────────

	async createPod(namespace: string, pod: K8sPod): Promise<K8sPod> {
		return this.request<K8sPod>("POST", `/api/v1/namespaces/${namespace}/pods`, pod);
	}

	async getPod(namespace: string, name: string): Promise<K8sPod> {
		return this.request<K8sPod>("GET", `/api/v1/namespaces/${namespace}/pods/${name}`);
	}

	async deletePod(namespace: string, name: string): Promise<void> {
		try {
			await this.request<K8sStatus>(
				"DELETE",
				`/api/v1/namespaces/${namespace}/pods/${name}`,
				undefined,
				{ gracePeriodSeconds: 0 },
			);
		} catch (err) {
			if (err instanceof KubernetesRuntimeError && err.statusCode === 404) {
				return;
			}
			throw err;
		}
	}

	async listPods(namespace: string, labelSelector?: string): Promise<K8sPodList> {
		const params: Record<string, string> = {};
		if (labelSelector) params.labelSelector = labelSelector;
		return this.request<K8sPodList>(
			"GET",
			`/api/v1/namespaces/${namespace}/pods`,
			undefined,
			params,
		);
	}

	/**
	 * Polls until the pod reaches Running phase or fails.
	 * @param timeoutMs Maximum wait time.
	 *   @default 120000
	 * @param pollMs Poll interval.
	 *   @default 1000
	 */
	async waitForPodRunning(
		namespace: string,
		name: string,
		timeoutMs = 120_000,
		pollMs = 1_000,
	): Promise<K8sPod> {
		const deadline = Date.now() + timeoutMs;

		while (Date.now() < deadline) {
			const pod = await this.getPod(namespace, name);
			const phase = pod.status?.phase;

			if (phase === "Running") {
				// If the pod has readiness probes, wait for all containers to be ready
				const statuses = pod.status?.containerStatuses ?? [];
				const allReady = statuses.length === 0 || statuses.every((s) => s.ready);
				if (allReady) return pod;
			}

			if (phase === "Failed" || phase === "Succeeded") {
				const statuses = pod.status?.containerStatuses ?? [];
				const waiting = statuses.find((s) => s.state.waiting);
				const reason = waiting?.state.waiting?.message ?? waiting?.state.waiting?.reason ?? phase;
				throw new KubernetesRuntimeError(
					`Pod ${name} reached terminal phase ${phase}: ${reason}`,
				);
			}

			// Check for ImagePullBackOff or ErrImagePull in container status
			const statuses = pod.status?.containerStatuses ?? [];
			for (const cs of statuses) {
				const waitReason = cs.state.waiting?.reason;
				if (
					waitReason === "ImagePullBackOff" ||
					waitReason === "ErrImagePull" ||
					waitReason === "InvalidImageName"
				) {
					throw new KubernetesRuntimeError(
						`Pod ${name} failed to start: ${waitReason}: ${cs.state.waiting?.message ?? ""}`,
					);
				}
			}

			await new Promise((r) => setTimeout(r, pollMs));
		}

		throw new KubernetesRuntimeError(
			`Pod ${name} did not reach Running phase within ${timeoutMs}ms`,
		);
	}

	// ── Pod logs ────────────────────────────────────────────────────────────

	async getPodLogs(
		namespace: string,
		name: string,
		tailLines?: number,
	): Promise<string> {
		const params: Record<string, string> = {};
		if (tailLines !== undefined) params.tailLines = String(tailLines);
		return this.requestText("GET", `/api/v1/namespaces/${namespace}/pods/${name}/log`, params);
	}

	// ── Service operations ──────────────────────────────────────────────────

	async createService(namespace: string, service: K8sService): Promise<K8sService> {
		return this.request<K8sService>(
			"POST",
			`/api/v1/namespaces/${namespace}/services`,
			service,
		);
	}

	async deleteService(namespace: string, name: string): Promise<void> {
		try {
			await this.request<K8sStatus>(
				"DELETE",
				`/api/v1/namespaces/${namespace}/services/${name}`,
			);
		} catch (err) {
			if (err instanceof KubernetesRuntimeError && err.statusCode === 404) {
				return;
			}
			throw err;
		}
	}

	// ── ConfigMap operations ────────────────────────────────────────────────

	async createConfigMap(namespace: string, configMap: K8sConfigMap): Promise<K8sConfigMap> {
		return this.request<K8sConfigMap>(
			"POST",
			`/api/v1/namespaces/${namespace}/configmaps`,
			configMap,
		);
	}

	async deleteConfigMap(namespace: string, name: string): Promise<void> {
		try {
			await this.request<K8sStatus>(
				"DELETE",
				`/api/v1/namespaces/${namespace}/configmaps/${name}`,
			);
		} catch (err) {
			if (err instanceof KubernetesRuntimeError && err.statusCode === 404) {
				return;
			}
			throw err;
		}
	}

	// ── NetworkPolicy operations ────────────────────────────────────────────

	async createNetworkPolicy(namespace: string, policy: K8sNetworkPolicy): Promise<K8sNetworkPolicy> {
		return this.request<K8sNetworkPolicy>(
			"POST",
			`/apis/networking.k8s.io/v1/namespaces/${namespace}/networkpolicies`,
			policy,
		);
	}

	async deleteNetworkPolicy(namespace: string, name: string): Promise<void> {
		try {
			await this.request<K8sStatus>(
				"DELETE",
				`/apis/networking.k8s.io/v1/namespaces/${namespace}/networkpolicies/${name}`,
			);
		} catch (err) {
			if (err instanceof KubernetesRuntimeError && err.statusCode === 404) {
				return;
			}
			throw err;
		}
	}

	// ── Namespace ───────────────────────────────────────────────────────────

	async getNamespace(name: string): Promise<K8sNamespace> {
		return this.request<K8sNamespace>("GET", `/api/v1/namespaces/${name}`);
	}

	// ── Exec via WebSocket ──────────────────────────────────────────────────

	/**
	 * Execute a command in a running pod via `kubectl exec`.
	 *
	 * Uses subprocess rather than the K8s exec WebSocket API because
	 * Bun's WebSocket client cannot send custom Authorization headers,
	 * and the `access_token` query parameter isn't universally enabled.
	 */
	async exec(
		namespace: string,
		name: string,
		command: string[],
		context?: string,
	): Promise<{ exitCode: number; stdout: string; stderr: string }> {
		const args = ["kubectl"];
		if (context) args.push("--context", context);
		args.push("-n", namespace, "exec", name, "--");
		args.push(...command);

		const proc = Bun.spawn(args, {
			stdout: "pipe",
			stderr: "pipe",
		});

		const [stdout, stderr] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
		]);
		const exitCode = await proc.exited;

		return { exitCode, stdout, stderr };
	}

	// ── HTTP helpers ────────────────────────────────────────────────────────

	private async request<T>(
		method: string,
		path: string,
		body?: unknown,
		queryParams?: Record<string, string | number>,
	): Promise<T> {
		const url = this.buildUrl(path, queryParams);
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.token}`,
			Accept: "application/json",
		};
		const init: RequestInit = { method, headers };

		if (body !== undefined) {
			headers["Content-Type"] = "application/json";
			init.body = JSON.stringify(body);
		}

		(init as Record<string, unknown>).tls = this.tlsOptions;

		const res = await fetch(url, init);
		const text = await res.text();

		if (!res.ok) {
			let message = `K8s API ${method} ${path}: ${res.status}`;
			try {
				const errBody = JSON.parse(text) as { message?: string };
				if (errBody.message) message = errBody.message;
			} catch {
				if (text) message += ` - ${text.slice(0, 200)}`;
			}
			throw new KubernetesRuntimeError(message, res.status);
		}

		if (!text) return {} as T;
		return JSON.parse(text) as T;
	}

	private async requestText(
		method: string,
		path: string,
		queryParams?: Record<string, string>,
	): Promise<string> {
		const url = this.buildUrl(path, queryParams);
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.token}`,
		};
		const res = await fetch(url, { method, headers, tls: this.tlsOptions } as RequestInit);
		if (!res.ok) {
			throw new KubernetesRuntimeError(
				`K8s API ${method} ${path}: ${res.status}`,
				res.status,
			);
		}
		return res.text();
	}

	private buildUrl(path: string, params?: Record<string, string | number>): string {
		const url = new URL(path, this.apiUrl);
		if (params) {
			for (const [k, v] of Object.entries(params)) {
				url.searchParams.set(k, String(v));
			}
		}
		return url.toString();
	}
}
