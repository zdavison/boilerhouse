import type { Socket, TCPSocketListener } from "bun";
import { createLogger } from "@boilerhouse/o11y";
import { matchesDomain } from "./matcher";

const log = createLogger("proxy");

/** Strip the `::ffff:` prefix from IPv4-mapped IPv6 addresses. */
function normalizeIp(ip: string): string {
	if (ip.startsWith("::ffff:")) return ip.slice(7);
	return ip;
}

export interface CredentialRule {
	domain: string;
	headers: Record<string, string>;
}

export interface InstanceRoute {
	allowlist: string[];
	credentials?: CredentialRule[];
	tenantId?: string;
}

interface ForwardProxyConfig {
	/** Port to listen on. Use 0 for an ephemeral port. */
	port: number;
	/**
	 * Resolves `${global-secret:NAME}` and `${tenant-secret:NAME}` templates
	 * in credential header values.
	 * Called at request time with the tenant ID and the raw template string.
	 */
	secretResolver?: (tenantId: string, template: string) => string;
}

interface SocketState {
	buffer: Buffer;
	phase: "header" | "tunnel";
	upstream: Socket<UpstreamState> | null;
}

interface UpstreamState {
	peer: Socket<SocketState>;
}

/**
 * A forward proxy that routes traffic based on source IP.
 *
 * Each registered source IP has an allowlist of permitted destination domains.
 * HTTP requests are forwarded if the Host header matches the allowlist.
 * HTTPS CONNECT tunnels are permitted if the target host matches.
 * Unknown source IPs are fail-closed (403).
 *
 * When credential rules are configured for a domain, the proxy:
 * - Injects resolved headers into HTTP requests before forwarding
 * - Connects to upstream over TLS (port 443) for credentialed domains
 * - Rejects CONNECT tunnels for credentialed domains (secrets would bypass injection)
 */
export class ForwardProxy {
	private readonly config: ForwardProxyConfig;
	private readonly routingTable = new Map<string, InstanceRoute>();
	private server: TCPSocketListener<SocketState> | null = null;

	/** The actual port the proxy is listening on (useful when config.port is 0). */
	get port(): number {
		if (!this.server) throw new Error("Proxy not started");
		return this.server.port;
	}

	constructor(config: ForwardProxyConfig) {
		this.config = config;
	}

	async start(): Promise<void> {
		this.server = Bun.listen<SocketState>({
			hostname: "0.0.0.0",
			port: this.config.port,
			socket: {
				open: (socket) => {
					socket.data = {
						buffer: Buffer.alloc(0),
						phase: "header",
						upstream: null,
					};
				},
				data: (socket, data) => {
					this.handleData(socket, Buffer.from(data));
				},
				error: (_socket, error) => {
					log.error({ err: error }, "Socket error");
				},
				close: (socket) => {
					socket.data.upstream?.end();
				},
			},
		});
	}

	async stop(): Promise<void> {
		this.server?.stop(true);
		this.server = null;
	}

	/** Register a source IP with its routing configuration. */
	addInstance(sourceIp: string, route: InstanceRoute): void {
		this.routingTable.set(normalizeIp(sourceIp), route);
	}

	/** Remove a source IP from the routing table. */
	removeInstance(sourceIp: string): void {
		this.routingTable.delete(normalizeIp(sourceIp));
	}

	private handleData(socket: Socket<SocketState>, data: Buffer): void {
		// In tunnel mode, forward raw bytes to upstream
		if (socket.data.phase === "tunnel") {
			socket.data.upstream?.write(data);
			return;
		}

		// Header phase: buffer until we see \r\n\r\n
		socket.data.buffer = Buffer.concat([socket.data.buffer, data]);
		const buf = socket.data.buffer;

		const headerEnd = buf.indexOf("\r\n\r\n");
		if (headerEnd === -1) return; // Need more data

		const headerStr = buf.subarray(0, headerEnd).toString();
		const lines = headerStr.split("\r\n");
		const requestLine = lines[0]!;
		const [method, target] = requestLine.split(" ");

		// Look up source IP route — normalize to handle IPv4-mapped IPv6 (::ffff:x.x.x.x)
		const sourceIp = normalizeIp(socket.remoteAddress);
		const route = this.routingTable.get(sourceIp);

		log.debug({ method, sourceIp, target, routeFound: !!route }, "Incoming request");

		if (!route) {
			log.warn({ sourceIp, method, target }, "Rejected request from unknown source IP");
			socket.write(
				"HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\nForbidden: unknown source IP\r\n",
			);
			socket.end();
			return;
		}

		if (method === "CONNECT") {
			this.handleConnect(socket, target!, route);
		} else {
			this.handleHttp(socket, buf, headerEnd, target!, lines, route);
		}
	}

	private handleConnect(
		socket: Socket<SocketState>,
		target: string,
		route: InstanceRoute,
	): void {
		const host = target.split(":")[0]!;

		if (!matchesDomain(host, route.allowlist)) {
			socket.write(
				"HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\nForbidden: domain not allowed\r\n",
			);
			socket.end();
			return;
		}

		// Reject CONNECT for credentialed domains — the proxy must see the
		// plaintext HTTP to inject headers, so CONNECT tunnels are not allowed.
		const credRule = this.findCredentialRule(host, route);
		if (credRule) {
			socket.write(
				"HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\nForbidden: CONNECT not allowed for credential-injected domains\r\n",
			);
			socket.end();
			return;
		}

		const [targetHost, targetPortStr] = target.split(":");
		const targetPort = parseInt(targetPortStr ?? "443", 10);

		socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
		socket.data.phase = "tunnel";
		socket.data.buffer = Buffer.alloc(0);

		Bun.connect<UpstreamState>({
			hostname: targetHost!,
			port: targetPort,
			socket: {
				open: (upstream) => {
					upstream.data = { peer: socket };
					socket.data.upstream = upstream;
				},
				data: (_upstream, chunk) => {
					socket.write(chunk);
				},
				close: () => {
					socket.end();
				},
				error: () => {
					socket.end();
				},
			},
		}).catch(() => {
			socket.end();
		});
	}

	private handleHttp(
		socket: Socket<SocketState>,
		fullData: Buffer,
		headerEnd: number,
		target: string,
		headerLines: string[],
		route: InstanceRoute,
	): void {
		const isDirectMode = target.startsWith("/");

		let host: string | undefined;
		let upstreamHost: string;
		let upstreamPort: number;
		let path: string;
		let useTls = false;
		let credRule: CredentialRule | undefined;

		if (isDirectMode) {
			// Direct connection mode: the client sent a relative URL (e.g. /v1/messages).
			// This happens when Node.js fetch() targets the proxy directly via
			// ANTHROPIC_BASE_URL instead of using HTTP_PROXY env vars.
			// Resolve the upstream from the first credential rule.
			credRule = route.credentials?.[0];
			if (!credRule) {
				socket.write(
					"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\nDirect request requires a credential rule to determine upstream\r\n",
				);
				socket.end();
				return;
			}

			host = credRule.domain;
			upstreamHost = credRule.domain;
			upstreamPort = 443;
			useTls = true;
			path = target;

			log.debug({ host, path, tenantId: route.tenantId }, "Direct-mode request");
		} else {
			// Forward-proxy mode: the client sent an absolute URL (e.g. http://api.anthropic.com/v1/messages)

			// Extract host from Host header or URL
			for (const line of headerLines) {
				if (line.toLowerCase().startsWith("host:")) {
					host = line.slice(5).trim().split(":")[0];
					break;
				}
			}

			if (!host && target.startsWith("http://")) {
				try {
					host = new URL(target).hostname;
				} catch {
					// invalid URL
				}
			}

			if (!host || !matchesDomain(host, route.allowlist)) {
				socket.write(
					"HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\nForbidden: domain not allowed\r\n",
				);
				socket.end();
				return;
			}

			credRule = this.findCredentialRule(host, route);

			log.debug({ host, credentialDomain: credRule?.domain, tenantId: route.tenantId }, "Forwarding HTTP request");

			let hasExplicitPort = false;

			try {
				const url = new URL(target);
				upstreamHost = url.hostname;
				hasExplicitPort = url.port !== "";
				upstreamPort = hasExplicitPort ? parseInt(url.port, 10) : 80;
				path = url.pathname + url.search;
			} catch {
				socket.write(
					"HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\nBad request URL\r\n",
				);
				socket.end();
				return;
			}

			// For credentialed domains without an explicit port, upgrade to TLS on 443
			if (credRule && !hasExplicitPort) {
				useTls = true;
				upstreamPort = 443;
			}
		}

		// Rewrite the request line to use a relative path
		const method = headerLines[0]!.split(" ")[0];
		const version = headerLines[0]!.split(" ")[2];
		const rewrittenRequestLine = `${method} ${path} ${version}`;
		let rewrittenHeaders = [
			rewrittenRequestLine,
			...headerLines.slice(1),
		];

		// In direct mode, rewrite the Host header from the proxy's address
		// to the actual upstream domain
		if (isDirectMode) {
			rewrittenHeaders = rewrittenHeaders.map((line, i) => {
				if (i === 0) return line;
				if (line.toLowerCase().startsWith("host:")) {
					return `Host: ${upstreamHost}`;
				}
				return line;
			});
		}

		// Inject credential headers, replacing any existing ones from the client
		if (credRule && this.config.secretResolver && route.tenantId) {
			const injectedNames = new Set(
				Object.keys(credRule.headers).map((h) => h.toLowerCase()),
			);

			// Strip client-sent headers that we're about to inject
			rewrittenHeaders = rewrittenHeaders.filter((line, i) => {
				if (i === 0) return true; // keep request line
				const colonIdx = line.indexOf(":");
				if (colonIdx === -1) return true;
				return !injectedNames.has(line.slice(0, colonIdx).trim().toLowerCase());
			});

			for (const [headerName, headerTemplate] of Object.entries(credRule.headers)) {
				const resolvedValue = this.config.secretResolver(
					route.tenantId,
					headerTemplate,
				);
				rewrittenHeaders.push(`${headerName}: ${resolvedValue}`);
			}
		}

		const rewrittenHead = rewrittenHeaders.join("\r\n") + "\r\n\r\n";
		const body = fullData.subarray(headerEnd + 4);
		const payload = Buffer.concat([Buffer.from(rewrittenHead), body]);

		if (useTls) {
			Bun.connect<Record<string, never>>({
				hostname: upstreamHost,
				port: upstreamPort,
				tls: true,
				socket: {
					open: (upstream) => {
						upstream.write(payload);
					},
					data: (_upstream, chunk) => {
						socket.write(chunk);
					},
					close: () => {
						socket.end();
					},
					error: () => {
						socket.write(
							"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\nUpstream TLS connection failed\r\n",
						);
						socket.end();
					},
				},
			}).catch(() => {
				socket.write(
					"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\nUpstream TLS connection failed\r\n",
				);
				socket.end();
			});
		} else {
			Bun.connect<Record<string, never>>({
				hostname: upstreamHost,
				port: upstreamPort,
				socket: {
					open: (upstream) => {
						upstream.write(payload);
					},
					data: (_upstream, chunk) => {
						socket.write(chunk);
					},
					close: () => {
						socket.end();
					},
					error: () => {
						socket.write(
							"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\nUpstream connection failed\r\n",
						);
						socket.end();
					},
				},
			}).catch(() => {
				socket.write(
					"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\nUpstream connection failed\r\n",
				);
				socket.end();
			});
		}
	}

	private findCredentialRule(
		host: string,
		route: InstanceRoute,
	): CredentialRule | undefined {
		if (!route.credentials) return undefined;
		const lower = host.toLowerCase();
		return route.credentials.find(
			(r) => r.domain.toLowerCase() === lower,
		);
	}
}
