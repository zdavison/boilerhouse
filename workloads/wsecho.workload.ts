import { defineWorkload } from "@boilerhouse/core";

export default defineWorkload({
	name: "wsecho",
	version: "0.1.0",
	image: { dockerfile: "wsecho/Dockerfile" },
	resources: { vcpus: 1, memory_mb: 256 },
	network: {
		access: "unrestricted",
		expose: [
			{ guest: 8080, host_range: [30000, 30099] },
			{ guest: 8081, host_range: [30100, 30199] },
		],
		websocket: "/ws",
	},
	idle: { timeout_seconds: 300, action: "hibernate" },
	health: {
		interval_seconds: 2,
		unhealthy_threshold: 30,
		http_get: { path: "/", port: 8081 },
	},
	entrypoint: {
		cmd: "python3",
		args: ["server.py"],
		workdir: "/app",
	},
	metadata: { description: "Python WebSocket echo server for connectivity testing" },
});
