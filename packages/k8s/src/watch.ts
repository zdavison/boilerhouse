import type { KubeClientConfig } from "./client";

// ── Generic list + watch types ───────────────────────────────────────────────

export interface CrdList<T> {
	apiVersion: string;
	kind: string;
	metadata: {
		resourceVersion: string;
		continue?: string;
	};
	items: T[];
}

export interface WatchEvent<T> {
	type: "ADDED" | "MODIFIED" | "DELETED" | "BOOKMARK" | "ERROR";
	object: T;
}

// ── KubeWatcher ──────────────────────────────────────────────────────────────

/** Minimum backoff in ms before reconnecting after a watch stream ends. */
const MIN_BACKOFF_MS = 500;
/** Maximum backoff in ms. */
const MAX_BACKOFF_MS = 30_000;

export type WatchEventHandler<T> = (event: WatchEvent<T>) => void | Promise<void>;

export interface KubeWatcherOptions<T> {
	/** Full path to the list/watch endpoint, e.g. `/apis/boilerhouse.dev/v1alpha1/boilerhouseclaims` */
	path: string;
	/** Called for each watch event (including synthetic ADDED for initial list items). */
	onEvent: WatchEventHandler<T>;
	/** Called when a non-recoverable error occurs. If omitted, errors are logged to stderr. */
	onError?: (err: Error) => void;
	/** Namespace to scope the watch to. When omitted, watches across all namespaces. */
	namespace?: string;
	/** Optional label selector. */
	labelSelector?: string;
}

/**
 * KubeWatcher streams Kubernetes watch events for a CRD endpoint.
 *
 * Behaviour:
 * - On start: lists all existing objects and emits synthetic ADDED events.
 * - Then: opens a streaming watch from the observed resourceVersion.
 * - On 410 Gone: re-lists and re-establishes watch (resourceVersion too old).
 * - On stream end or transient error: reconnects with exponential backoff.
 * - Tracks resourceVersion from BOOKMARK events.
 */
export class KubeWatcher<T extends { metadata: { resourceVersion?: string } }> {
	private readonly config: KubeClientConfig;
	private readonly options: KubeWatcherOptions<T>;
	private readonly tlsOptions: { rejectUnauthorized: boolean; ca?: string };

	private running = false;
	private resourceVersion = "";
	private backoffMs = MIN_BACKOFF_MS;
	private abortController: AbortController | null = null;

	constructor(config: KubeClientConfig, options: KubeWatcherOptions<T>) {
		this.config = config;
		this.options = options;
		this.tlsOptions = config.caCert
			? { rejectUnauthorized: true, ca: config.caCert }
			: { rejectUnauthorized: false };
	}

	/**
	 * Start watching. Returns immediately; the watch loop runs in the background.
	 * Call `stop()` to halt.
	 */
	start(): void {
		if (this.running) return;
		this.running = true;
		void this.loop();
	}

	/** Stop the watch loop. Any in-flight request is aborted. */
	stop(): void {
		this.running = false;
		this.abortController?.abort();
	}

	// ── Internal ─────────────────────────────────────────────────────────────

	private async loop(): Promise<void> {
		while (this.running) {
			try {
				// Phase 1: list to get current state + resourceVersion
				await this.doList();
				this.backoffMs = MIN_BACKOFF_MS; // reset backoff after successful list

				// Phase 2: stream watch events
				if (this.running) {
					await this.doWatch();
				}
			} catch (err) {
				if (!this.running) return;
				this.handleError(err instanceof Error ? err : new Error(String(err)));
				await this.sleep(this.backoffMs);
				this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
			}
		}
	}

	private async doList(): Promise<void> {
		const url = this.buildUrl(this.listPath());
		const res = await fetch(url, {
			headers: { Authorization: `Bearer ${this.config.token}`, Accept: "application/json" },
			tls: this.tlsOptions,
		} as RequestInit);

		if (!res.ok) {
			throw new Error(`K8s list ${this.listPath()} failed: ${res.status}`);
		}

		const list = (await res.json()) as CrdList<T>;
		this.resourceVersion = list.metadata.resourceVersion;

		for (const item of list.items) {
			await this.options.onEvent({ type: "ADDED", object: item });
		}
	}

	private async doWatch(): Promise<void> {
		this.abortController = new AbortController();
		const url = this.buildUrl(this.listPath(), {
			watch: "1",
			resourceVersion: this.resourceVersion,
			allowWatchBookmarks: "true",
		});

		const res = await fetch(url, {
			headers: { Authorization: `Bearer ${this.config.token}`, Accept: "application/json" },
			signal: this.abortController.signal,
			tls: this.tlsOptions,
		} as RequestInit);

		if (!res.ok) {
			if (res.status === 410) {
				// resourceVersion too old — caller will re-list
				this.resourceVersion = "";
				return;
			}
			throw new Error(`K8s watch ${this.listPath()} failed: ${res.status}`);
		}

		if (!res.body) return;

		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buf = "";

		try {
			while (this.running) {
				const { done, value } = await reader.read();
				if (done) break;

				buf += decoder.decode(value, { stream: true });
				const lines = buf.split("\n");
				buf = lines.pop() ?? "";

				for (const line of lines) {
					const trimmed = line.trim();
					if (!trimmed) continue;

					let event: WatchEvent<T>;
					try {
						event = JSON.parse(trimmed) as WatchEvent<T>;
					} catch {
						continue;
					}

					if (event.type === "BOOKMARK") {
						const rv = (event.object as { metadata?: { resourceVersion?: string } })
							?.metadata?.resourceVersion;
						if (rv) this.resourceVersion = rv;
						continue;
					}

					if (event.type === "ERROR") {
						const status = event.object as unknown as { code?: number; message?: string };
						if (status.code === 410) {
							// Gone — break out so doList() is called again
							this.resourceVersion = "";
							return;
						}
						throw new Error(`Watch ERROR event: ${status.message ?? JSON.stringify(status)}`);
					}

					if (event.object?.metadata?.resourceVersion) {
						this.resourceVersion = event.object.metadata.resourceVersion;
					}

					await this.options.onEvent(event);
				}
			}
		} finally {
			reader.releaseLock();
		}
	}

	private listPath(): string {
		const { path, namespace } = this.options;
		if (namespace) {
			// Inject namespace into the path: /apis/group/version/namespaces/NS/resource
			const parts = path.split("/");
			// path format: /apis/GROUP/VERSION/RESOURCE → /apis/GROUP/VERSION/namespaces/NS/RESOURCE
			const resource = parts[parts.length - 1];
			const prefix = parts.slice(0, parts.length - 1).join("/");
			return `${prefix}/namespaces/${namespace}/${resource}`;
		}
		return path;
	}

	private buildUrl(path: string, params?: Record<string, string>): string {
		const base = this.config.apiUrl.replace(/\/$/, "");
		const url = new URL(path, base);
		if (this.options.labelSelector) {
			url.searchParams.set("labelSelector", this.options.labelSelector);
		}
		if (params) {
			for (const [k, v] of Object.entries(params)) {
				url.searchParams.set(k, v);
			}
		}
		return url.toString();
	}

	private handleError(err: Error): void {
		if (this.options.onError) {
			this.options.onError(err);
		} else {
			console.error("[KubeWatcher] error:", err.message);
		}
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
