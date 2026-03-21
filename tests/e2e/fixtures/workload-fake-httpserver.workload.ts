import { defineWorkload } from "@boilerhouse/core";

export default defineWorkload({
	name: "e2e-fake-httpserver",
	version: "1.0.0",
	image: { ref: "fake:latest" },
	resources: { vcpus: 1, memory_mb: 256 },
	network: {
		access: "outbound",
		expose: [{ guest: 8080, host_range: [30000, 31000] }],
	},
	idle: { action: "hibernate" },
	health: {
		interval_seconds: 2,
		unhealthy_threshold: 30,
		http_get: { path: "/", port: 8080 },
	},
});
