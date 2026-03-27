import { describe, expect, test } from "bun:test";
import yaml from "js-yaml";
import { generateEnvoyConfig } from "./config";
import type { SidecarProxyConfig } from "./types";

/** Parse the generated YAML config for assertion. */
function generate(config: SidecarProxyConfig): Record<string, unknown> {
	const { envoyConfig } = generateEnvoyConfig(config);
	return yaml.load(envoyConfig) as Record<string, unknown>;
}

function getListener(config: Record<string, unknown>): Record<string, unknown> {
	const resources = config.static_resources as Record<string, unknown>;
	const listeners = resources.listeners as Record<string, unknown>[];
	return listeners[0]!;
}

function getHcm(config: Record<string, unknown>): Record<string, unknown> {
	const listener = getListener(config);
	const filterChains = listener.filter_chains as Record<string, unknown>[];
	const filters = filterChains[0]!.filters as Record<string, unknown>[];
	return filters[0]!.typed_config as Record<string, unknown>;
}

function getVirtualHosts(config: Record<string, unknown>): Record<string, unknown>[] {
	const hcm = getHcm(config);
	const routeConfig = hcm.route_config as Record<string, unknown>;
	return routeConfig.virtual_hosts as Record<string, unknown>[];
}

function getClusters(config: Record<string, unknown>): Record<string, unknown>[] {
	const resources = config.static_resources as Record<string, unknown>;
	return (resources.clusters ?? []) as Record<string, unknown>[];
}

describe("generateEnvoyConfig", () => {
	test("generates valid YAML", () => {
		const { envoyConfig } = generateEnvoyConfig({ allowlist: ["example.com"] });
		expect(() => yaml.load(envoyConfig)).not.toThrow();
	});

	test("listens on default port 18080", () => {
		const config = generate({ allowlist: ["example.com"] });
		const listener = getListener(config);
		const address = listener.address as Record<string, unknown>;
		const socket = address.socket_address as Record<string, unknown>;
		expect(socket.port_value).toBe(18080);
		expect(socket.address).toBe("127.0.0.1");
	});

	test("respects custom port", () => {
		const config = generate({ allowlist: ["example.com"], port: 9090 });
		const listener = getListener(config);
		const address = listener.address as Record<string, unknown>;
		const socket = address.socket_address as Record<string, unknown>;
		expect(socket.port_value).toBe(9090);
	});

	test("enables forward proxy mode (allow_absolute_url)", () => {
		const config = generate({ allowlist: ["example.com"] });
		const hcm = getHcm(config);
		const httpOpts = hcm.http_protocol_options as Record<string, unknown>;
		expect(httpOpts.allow_absolute_url).toBe(true);
	});

	test("creates virtual host per allowed domain", () => {
		const config = generate({
			allowlist: ["api.anthropic.com", "api.openai.com"],
		});
		const vhosts = getVirtualHosts(config);
		// 2 domains + catch-all deny
		expect(vhosts).toHaveLength(3);

		expect(vhosts[0]!.domains).toEqual(["api.anthropic.com"]);
		expect(vhosts[1]!.domains).toEqual(["api.openai.com"]);
	});

	test("catch-all virtual host returns 403", () => {
		const config = generate({ allowlist: ["example.com"] });
		const vhosts = getVirtualHosts(config);
		const denyAll = vhosts[vhosts.length - 1]!;
		expect(denyAll.domains).toEqual(["*"]);

		const routes = denyAll.routes as Record<string, unknown>[];
		const directResponse = routes[0]!.direct_response as Record<string, unknown>;
		expect(directResponse.status).toBe(403);
	});

	test("creates TLS-originating cluster per domain", () => {
		const config = generate({
			allowlist: ["api.anthropic.com", "example.com"],
		});
		const clusters = getClusters(config);
		// 2 domain clusters + 1 deny_cluster for TLS
		expect(clusters).toHaveLength(3);

		const cluster = clusters[0]!;
		expect(cluster.name).toBe("upstream_api_anthropic_com");
		expect(cluster.type).toBe("STRICT_DNS");

		// TLS origination
		const transportSocket = cluster.transport_socket as Record<string, unknown>;
		const tlsConfig = transportSocket.typed_config as Record<string, unknown>;
		expect(tlsConfig.sni).toBe("api.anthropic.com");

		// Upstream address
		const loadAssignment = cluster.load_assignment as Record<string, unknown>;
		const endpoints = loadAssignment.endpoints as Record<string, unknown>[];
		const lbEndpoints = endpoints[0]!.lb_endpoints as Record<string, unknown>[];
		const endpoint = lbEndpoints[0]!.endpoint as Record<string, unknown>;
		const addr = endpoint.address as Record<string, unknown>;
		const socket = addr.socket_address as Record<string, unknown>;
		expect(socket.address).toBe("api.anthropic.com");
		expect(socket.port_value).toBe(443);
	});

	test("injects credential headers for credentialed domains", () => {
		const config = generate({
			allowlist: ["api.anthropic.com"],
			credentials: [
				{
					domain: "api.anthropic.com",
					headers: { "x-api-key": "sk-ant-test-key" },
				},
			],
		});
		const vhosts = getVirtualHosts(config);
		const anthropic = vhosts[0]!;
		const routes = anthropic.routes as Record<string, unknown>[];
		const headersToAdd = routes[0]!.request_headers_to_add as Record<string, unknown>[];

		expect(headersToAdd).toHaveLength(1);
		expect(headersToAdd[0]!.header).toEqual({
			key: "x-api-key",
			value: "sk-ant-test-key",
		});
		expect(headersToAdd[0]!.append_action).toBe("OVERWRITE_IF_EXISTS_OR_ADD");
	});

	test("injects multiple credential headers", () => {
		const config = generate({
			allowlist: ["api.example.com"],
			credentials: [
				{
					domain: "api.example.com",
					headers: {
						Authorization: "Bearer token123",
						"X-Custom": "custom-value",
					},
				},
			],
		});
		const vhosts = getVirtualHosts(config);
		const vhost = vhosts[0]!;
		const routes = vhost.routes as Record<string, unknown>[];
		const headersToAdd = routes[0]!.request_headers_to_add as Record<string, unknown>[];

		expect(headersToAdd).toHaveLength(2);
	});

	test("does not inject headers for non-credentialed domains", () => {
		const config = generate({
			allowlist: ["api.anthropic.com", "example.com"],
			credentials: [
				{
					domain: "api.anthropic.com",
					headers: { "x-api-key": "sk-test" },
				},
			],
		});
		const vhosts = getVirtualHosts(config);

		const example = vhosts[1]!;
		expect(example.domains).toEqual(["example.com"]);
		const routes = example.routes as Record<string, unknown>[];
		expect(routes[0]!.request_headers_to_add).toBeUndefined();
	});

	test("handles wildcard domains in allowlist", () => {
		const config = generate({
			allowlist: ["*.example.com", "api.anthropic.com"],
		});
		const vhosts = getVirtualHosts(config);

		const wildcard = vhosts[0]!;
		expect(wildcard.domains).toEqual(["*.example.com"]);

		// 1 concrete domain cluster + 1 deny_cluster for TLS
		const clusters = getClusters(config);
		expect(clusters).toHaveLength(2);
	});

	test("credential matching is case-insensitive", () => {
		const config = generate({
			allowlist: ["API.Anthropic.COM"],
			credentials: [
				{
					domain: "api.anthropic.com",
					headers: { "x-api-key": "sk-test" },
				},
			],
		});
		const vhosts = getVirtualHosts(config);
		const vhost = vhosts[0]!;
		const routes = vhost.routes as Record<string, unknown>[];
		expect(routes[0]!.request_headers_to_add).toBeDefined();
	});

	test("empty allowlist produces only deny-all", () => {
		const config = generate({ allowlist: [] });
		const vhosts = getVirtualHosts(config);
		expect(vhosts).toHaveLength(1);
		expect(vhosts[0]!.name).toBe("deny_all");

		const clusters = getClusters(config);
		expect(clusters).toHaveLength(0);
	});

	test("admin endpoint on port 18081", () => {
		const config = generate({ allowlist: [] });
		const admin = config.admin as Record<string, unknown>;
		const address = admin.address as Record<string, unknown>;
		const socket = address.socket_address as Record<string, unknown>;
		expect(socket.port_value).toBe(18081);
		expect(socket.address).toBe("127.0.0.1");
	});

	test("includes http router filter", () => {
		const config = generate({ allowlist: ["example.com"] });
		const hcm = getHcm(config);
		const httpFilters = hcm.http_filters as Record<string, unknown>[];
		expect(httpFilters).toHaveLength(1);
		expect(httpFilters[0]!.name).toBe("envoy.filters.http.router");
	});
});
