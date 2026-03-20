import { readFileSync } from "node:fs";
import { join } from "node:path";
import Handlebars from "handlebars";
import type { SidecarProxyConfig } from "./types";

const DEFAULT_PORT = 18080;
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
 * Generates an Envoy bootstrap config for a sidecar proxy.
 *
 * The proxy listens on localhost in forward-proxy mode (absolute URLs),
 * filters by domain allowlist, injects credential headers, and originates
 * TLS to upstream on port 443.
 *
 * Returns a YAML string ready to write to a config file.
 */
export function generateEnvoyConfig(config: SidecarProxyConfig): string {
	const port = config.port ?? DEFAULT_PORT;
	const credentials = config.credentials ?? [];

	const credentialsByDomain = new Map(
		credentials.map((c) => [c.domain.toLowerCase(), c]),
	);

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

	return template({ port, adminPort: ADMIN_PORT, domains, clusters });
}
