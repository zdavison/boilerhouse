import { readFileSync } from "node:fs";
import { join } from "node:path";
import Handlebars from "handlebars";
import type { SidecarProxyConfig, SidecarProxyOutput } from "./types";
import { generateTlsMaterial } from "./tls";

const DEFAULT_PORT = 18080;
const DEFAULT_TLS_PORT = 18443;
const ADMIN_PORT = 18081;

/** Convert a domain to a safe identifier: dots/wildcards to underscores. */
function safeName(domain: string): string {
	return domain.replace(/[.*]/g, "_").replace(/^_+/, "");
}

Handlebars.registerHelper("safeName", safeName);

const templateSource = readFileSync(
	join(import.meta.dirname, "envoy-bootstrap.yaml.hbs"),
	"utf-8",
);
const template = Handlebars.compile(templateSource, { noEscape: true });

/**
 * Generates an Envoy bootstrap config for a sidecar proxy with
 * transparent TLS interception (MITM) for HTTPS traffic.
 *
 * Returns the Envoy YAML config and TLS material (CA cert to trust,
 * per-domain certs for Envoy to serve).
 */
export function generateEnvoyConfig(config: SidecarProxyConfig): SidecarProxyOutput {
	const port = config.port ?? DEFAULT_PORT;
	const tlsPort = config.tlsPort ?? DEFAULT_TLS_PORT;
	const credentials = config.credentials ?? [];

	const credentialsByDomain = new Map(
		credentials.map((c) => [c.domain.toLowerCase(), c]),
	);

	// Non-wildcard domains that need TLS interception
	const concreteDomains = config.allowlist
		.map((d) => d.toLowerCase())
		.filter((d) => !d.startsWith("*."));

	const domains = config.allowlist.map((d) => {
		const lower = d.toLowerCase();
		const cred = credentialsByDomain.get(lower);
		return {
			domain: lower,
			isWildcard: lower.startsWith("*."),
			headers: cred
				? Object.entries(cred.headers).map(([key, value]) => ({ key, value }))
				: null,
		};
	});

	// Clusters only for non-wildcard domains
	const clusters = domains.filter((d) => !d.isWildcard);

	// Generate TLS material for MITM
	const tls = generateTlsMaterial(concreteDomains);

	// Build per-domain TLS cert references for the template, including headers
	const tlsDomains = tls.certs.map((c) => {
		const cred = credentialsByDomain.get(c.domain.toLowerCase());
		return {
			domain: c.domain,
			safe: safeName(c.domain),
			headers: cred
				? Object.entries(cred.headers).map(([key, value]) => ({ key, value }))
				: null,
		};
	});

	const envoyConfig = template({
		port,
		tlsPort,
		adminPort: ADMIN_PORT,
		domains,
		clusters,
		tlsDomains,
		hasTls: tlsDomains.length > 0,
	});

	return { envoyConfig, tls };
}
