import type { Workload, TenantId, CreateOptions } from "@boilerhouse/core";
import { generateEnvoyConfig } from "@boilerhouse/envoy-config";
import type { CredentialRule } from "@boilerhouse/envoy-config";
import type { SecretStore } from "../secret-store";

/**
 * Build CreateOptions with Envoy sidecar proxy config for workloads
 * that have restricted network access with credentials.
 */
export function buildProxyCreateOptions(
	workload: Workload,
	secretStore?: SecretStore,
	tenantId?: TenantId,
): CreateOptions | undefined {
	if (workload.network.access !== "restricted" || !secretStore) {
		return undefined;
	}

	const allowlist = workload.network.allowlist ?? [];

	let credentials: CredentialRule[] | undefined;
	if (workload.network.credentials && workload.network.credentials.length > 0) {
		credentials = workload.network.credentials.map((cred) => {
			const resolvedHeaders: Record<string, string> = {};
			for (const [key, template] of Object.entries(cred.headers)) {
				resolvedHeaders[key] = secretStore.resolveSecretRefs(
					tenantId ?? ("" as TenantId),
					template,
				);
			}
			return { domain: cred.domain, headers: resolvedHeaders };
		});
	}

	const { envoyConfig, tls } = generateEnvoyConfig({ allowlist, credentials });

	return {
		proxyConfig: envoyConfig,
		proxyCaCert: tls?.caCert,
		proxyCerts: tls?.certs,
	};
}
