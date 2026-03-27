import index from "./index.html";

const API_URL = process.env.API_URL ?? "http://localhost:3000";
const METRICS_URL = process.env.METRICS_URL ?? "http://localhost:9464";
const PROMETHEUS_URL = process.env.PROMETHEUS_URL ?? "http://localhost:9090";

interface WsData {
	upstream: WebSocket;
}

const server = Bun.serve<WsData>({
	port: Number(process.env.PORT ?? 3001),
	hostname: process.env.LISTEN_HOST ?? "127.0.0.1",
	routes: {
		"/": index,
	},
	fetch(req, server) {
		const url = new URL(req.url);

		// WebSocket upgrade for /ws
		if (url.pathname === "/ws") {
			const wsUrl = new URL("/ws", API_URL.replace(/^http/, "ws"));
			const upstream = new WebSocket(wsUrl.toString());
			const success = server.upgrade(req, { data: { upstream } });
			if (!success) {
				return new Response("WebSocket upgrade failed", { status: 400 });
			}
			return undefined;
		}

		// Proxy /metrics to the Prometheus exporter
		if (url.pathname === "/metrics") {
			const upstream = new URL("/metrics", METRICS_URL);
			const headers = new Headers(req.headers);
			headers.delete("host");
			return fetch(upstream.toString(), { method: "GET", headers }).catch(
				() => new Response("Cannot reach metrics endpoint", { status: 502 }),
			);
		}

		// Proxy /prometheus/* to the Prometheus query API
		if (url.pathname.startsWith("/prometheus/")) {
			const promPath = url.pathname.replace(/^\/prometheus/, "");
			const upstream = new URL(promPath + url.search, PROMETHEUS_URL);
			const headers = new Headers(req.headers);
			headers.delete("host");
			return fetch(upstream.toString(), {
				method: req.method,
				headers,
				body: req.body,
			}).catch(
				() => new Response(JSON.stringify({ error: "Cannot reach Prometheus" }), {
					status: 502,
					headers: { "Content-Type": "application/json" },
				}),
			);
		}

		// Proxy /api/* requests to the API server
		if (url.pathname.startsWith("/api/")) {
			const upstream = new URL(url.pathname + url.search, API_URL);
			const headers = new Headers(req.headers);
			headers.delete("host");
			return fetch(upstream.toString(), {
				method: req.method,
				headers,
				body: req.body,
			}).catch(
				() =>
					new Response(JSON.stringify({ error: "Cannot reach API server" }), {
						status: 502,
						headers: { "Content-Type": "application/json" },
					}),
			);
		}

		// Catch-all: serve index.html for SPA routing
		return new Response(Bun.file(new URL("./index.html", import.meta.url)));
	},
	websocket: {
		open(ws) {
			const { upstream } = ws.data;
			upstream.onmessage = (event) => {
				ws.send(typeof event.data === "string" ? event.data : "");
			};
			upstream.onclose = () => ws.close();
		},
		message(_ws, _message) {
			// Client-to-server messages are not used
		},
		close(ws) {
			ws.data.upstream.close();
		},
	},
	development: {
		hmr: true,
		console: true,
	},
});

console.log(`♨️ Dashboard listening on ${server.url}`);
