import { defineWorkload } from "@boilerhouse/core";

export default defineWorkload({
	name: "wsecho",
	version: "0.1.0",
	image: { dockerfile: "wsecho/Dockerfile" },
	resources: { vcpus: 1, memory_mb: 256 },
	network: {
		access: "none",
		expose: [{ guest: 8080, host_range: [40000, 41000] }],
	},
	idle: { timeout_seconds: 300, action: "hibernate" },
	health: {
		interval_seconds: 2,
		unhealthy_threshold: 30,
		http_get: { path: "/", port: 8080 },
	},
	metadata: { description: "WebSocket echo server for connectivity testing" },
});
