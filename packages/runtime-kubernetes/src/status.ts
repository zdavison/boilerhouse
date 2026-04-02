import type { KubeClientConfig } from "./client";
import { KubernetesRuntimeError } from "./errors";

// ── Finalizer helpers ────────────────────────────────────────────────────────

/** The standard finalizer name used by the Boilerhouse operator. */
export const FINALIZER = "boilerhouse.dev/cleanup";

export interface FinalizableMetadata {
	finalizers?: string[];
}

/**
 * Returns a new metadata object with the given finalizer added.
 * Idempotent — if the finalizer is already present the original object is returned.
 */
export function addFinalizer<T extends FinalizableMetadata>(metadata: T, finalizer: string): T {
	if (metadata.finalizers?.includes(finalizer)) {
		return metadata;
	}
	return {
		...metadata,
		finalizers: [...(metadata.finalizers ?? []), finalizer],
	};
}

/**
 * Returns a new metadata object with the given finalizer removed.
 * Idempotent — if the finalizer is not present the original object is returned.
 */
export function removeFinalizer<T extends FinalizableMetadata>(metadata: T, finalizer: string): T {
	if (!metadata.finalizers?.includes(finalizer)) {
		return metadata;
	}
	return {
		...metadata,
		finalizers: metadata.finalizers.filter((f) => f !== finalizer),
	};
}

// ── Status patcher ───────────────────────────────────────────────────────────

/** Abstraction over K8s status/metadata patching for a specific resource type. */
export interface StatusPatcher<TStatus = unknown, TMeta = unknown> {
	/**
	 * Merge-patch the `/status` subresource.
	 * Only the provided fields are updated; others are left unchanged.
	 */
	patchStatus(namespace: string, name: string, patch: Partial<TStatus>): Promise<void>;

	/**
	 * Strategic-merge-patch the object metadata (e.g. to update finalizers).
	 * Only the provided fields are updated; others are left unchanged.
	 */
	patchMetadata(namespace: string, name: string, patch: Partial<TMeta>): Promise<void>;
}

/**
 * KubeStatusPatcher implements StatusPatcher using the K8s REST API.
 *
 * `resourcePath` is the base path for the resource, e.g.:
 *   `/apis/boilerhouse.dev/v1alpha1/boilerhouseclaims`
 */
export class KubeStatusPatcher<TStatus = unknown, TMeta = unknown>
	implements StatusPatcher<TStatus, TMeta>
{
	private readonly apiUrl: string;
	private readonly token: string;
	private readonly tlsOptions: { rejectUnauthorized: boolean; ca?: string };
	private readonly resourcePath: string;

	constructor(config: KubeClientConfig, resourcePath: string) {
		this.apiUrl = config.apiUrl.replace(/\/$/, "");
		this.token = config.token;
		this.tlsOptions = config.caCert
			? { rejectUnauthorized: true, ca: config.caCert }
			: { rejectUnauthorized: false };
		this.resourcePath = resourcePath;
	}

	async patchStatus(namespace: string, name: string, patch: Partial<TStatus>): Promise<void> {
		const path = `/apis/${this.nsPath(namespace)}/${name}/status`;
		await this.mergePatch(path, { status: patch });
	}

	async patchMetadata(namespace: string, name: string, patch: Partial<TMeta>): Promise<void> {
		const path = `/apis/${this.nsPath(namespace)}/${name}`;
		await this.strategicMergePatch(path, { metadata: patch });
	}

	// ── Private ───────────────────────────────────────────────────────────────

	private nsPath(namespace: string): string {
		// resourcePath is e.g. "boilerhouse.dev/v1alpha1/boilerhouseclaims"
		// We need to inject "namespaces/NS/" before the resource name
		const parts = this.resourcePath.replace(/^\/+/, "").split("/");
		const resource = parts[parts.length - 1];
		const prefix = parts.slice(0, parts.length - 1).join("/");
		return `${prefix}/namespaces/${namespace}/${resource}`;
	}

	private async mergePatch(path: string, body: unknown): Promise<void> {
		await this.patch(path, body, "application/merge-patch+json");
	}

	private async strategicMergePatch(path: string, body: unknown): Promise<void> {
		await this.patch(path, body, "application/strategic-merge-patch+json");
	}

	private async patch(path: string, body: unknown, contentType: string): Promise<void> {
		const url = `${this.apiUrl}${path}`;
		const res = await fetch(url, {
			method: "PATCH",
			headers: {
				Authorization: `Bearer ${this.token}`,
				"Content-Type": contentType,
				Accept: "application/json",
			},
			body: JSON.stringify(body),
			tls: this.tlsOptions,
		} as RequestInit);

		if (!res.ok) {
			const text = await res.text().catch(() => "");
			let message = `K8s PATCH ${path}: ${res.status}`;
			try {
				const errBody = JSON.parse(text) as { message?: string };
				if (errBody.message) message = errBody.message;
			} catch {
				if (text) message += ` - ${text.slice(0, 200)}`;
			}
			throw new KubernetesRuntimeError(message, res.status);
		}

		// Consume response body to avoid connection leaks
		await res.body?.cancel();
	}
}
