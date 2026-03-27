import { defineWorkload } from "@boilerhouse/core";

export default defineWorkload({
	name: "e2e-httpserver",
	version: "1.0.0",
	image: { ref: "docker.io/library/python:3-alpine" },
	resources: { vcpus: 1, memory_mb: 256 },
	network: {
		access: "outbound",
		expose: [{ guest: 8080, host_range: [30000, 31000] }],
	},
	idle: { timeout_seconds: 300, action: "destroy" },
	health: {
		interval_seconds: 2,
		unhealthy_threshold: 30,
		http_get: { path: "/", port: 8080 },
	},
	entrypoint: {
		cmd: "/usr/local/bin/python3",
		args: ["-m", "http.server", "8080"],
	},
	metadata: { description: "Python HTTP server for Docker E2E testing" },
});
