/** Pre-resolved credential rule for a single domain. */
export interface CredentialRule {
	/** Target domain (e.g., "api.anthropic.com"). */
	domain: string;
	/** Headers to inject. Values are already resolved (no secret templates). */
	headers: Record<string, string>;
}

/** Input for Envoy sidecar config generation. */
export interface SidecarProxyConfig {
	/** Domains the workload is allowed to reach. Supports wildcards (e.g., "*.example.com"). */
	allowlist: string[];
	/** Pre-resolved credential rules. Secret templates already replaced with actual values. */
	credentials?: CredentialRule[];
	/** Envoy listener port. @default 18080 */
	port?: number;
}
