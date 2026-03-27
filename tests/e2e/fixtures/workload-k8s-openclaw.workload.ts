import { defineWorkload } from "@boilerhouse/core";

export default defineWorkload({
	name: "e2e-openclaw",
	version: "1.0.0",
	image: { ref: "docker.io/library/python:3-alpine" },
	resources: { vcpus: 2, memory_mb: 2048, disk_gb: 10 },
	network: {
		access: "restricted",
		allowlist: [
			"api.anthropic.com",
			"api.openai.com",
			"registry.npmjs.org",
		],
		expose: [{ guest: 18789, host_range: [0, 0] }],
		credentials: [{
			domain: "api.anthropic.com",
			headers: { "x-api-key": "${global-secret:ANTHROPIC_API_KEY}" },
		}],
	},
	idle: { timeout_seconds: 600, action: "hibernate" },
	health: {
		interval_seconds: 2,
		unhealthy_threshold: 60,
		http_get: { path: "/", port: 18789 },
	},
	entrypoint: {
		cmd: "/usr/local/bin/python3",
		args: ["-m", "http.server", "18789"],
		env: { ANTHROPIC_BASE_URL: "http://api.anthropic.com" },
	},
	metadata: { description: "OpenClaw stand-in for K8s E2E testing" },
});
