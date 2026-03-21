import { defineWorkload } from "@boilerhouse/core";

export default defineWorkload({
	name: "e2e-fake-openclaw",
	version: "1.0.0",
	image: { ref: "fake:latest" },
	resources: { vcpus: 2, memory_mb: 2048, disk_gb: 10 },
	network: {
		access: "restricted",
		allowlist: [
			"api.anthropic.com",
			"api.openai.com",
			"registry.npmjs.org",
		],
		expose: [{ guest: 18789, host_range: [30000, 30099] }],
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
});
