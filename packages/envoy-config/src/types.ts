/** Pre-resolved credential rule for a single domain. */
export interface CredentialRule {
	/** Target domain (e.g., "api.anthropic.com"). */
	domain: string;
	/** Headers to inject. Values are already resolved (no secret templates). */
	headers: Record<string, string>;
}

/** Generated TLS material for the MITM proxy. */
export interface TlsMaterial {
	/** PEM-encoded CA certificate (trusted by the workload). */
	caCert: string;
	/** PEM-encoded CA private key. */
	caKey: string;
	/** Per-domain cert/key pairs signed by the CA. */
	certs: Array<{ domain: string; cert: string; key: string }>;
}

/** Output from config generation — Envoy YAML + TLS material. */
export interface SidecarProxyOutput {
	/** Envoy bootstrap YAML config. */
	envoyConfig: string;
	/** TLS material for MITM proxy (undefined if no TLS interception needed). */
	tls?: TlsMaterial;
}

/** Input for Envoy sidecar config generation. */
export interface SidecarProxyConfig {
	/** Domains the workload is allowed to reach. Supports wildcards (e.g., "*.example.com"). */
	allowlist: string[];
	/** Pre-resolved credential rules. Secret templates already replaced with actual values. */
	credentials?: CredentialRule[];
	/** Envoy listener port for HTTP. @default 18080 */
	port?: number;
	/** Envoy listener port for TLS termination. @default 18443 */
	tlsPort?: number;
}
