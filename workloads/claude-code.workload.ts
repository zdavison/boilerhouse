import { defineWorkload, secret } from "@boilerhouse/core";

export default defineWorkload({
	name: "claude-code",
	version: "2026.3.26d",
	image: { dockerfile: "claude-code/Dockerfile" },
	resources: { vcpus: 2, memory_mb: 4096, disk_gb: 20 },
	network: {
		access: "restricted",
		allowlist: [
			"api.anthropic.com",
			"statsig.anthropic.com",
			"sentry.io",
			"registry.npmjs.org",
			"github.com",
			"api.github.com",
		],
		expose: [{ guest: 7880, host_range: [30000, 30099] }],
		websocket: "/ws",
		credentials: [{
			domain: "api.anthropic.com",
			headers: { "x-api-key": secret("ANTHROPIC_API_KEY") },
		}],
	},
	filesystem: { overlay_dirs: ["/workspace", "/home/claude"] },
	idle: { timeout_seconds: 300, action: "hibernate" },
	health: {
		interval_seconds: 2,
		unhealthy_threshold: 30,
		http_get: { path: "/health", port: 7880 },
	},
	entrypoint: {
		cmd: "node",
		args: ["bridge.mjs"],
		workdir: "/app",
		env: {
			ANTHROPIC_API_KEY: "sk-ant-proxy-managed",
			ANTHROPIC_BASE_URL: "http://api.anthropic.com",
			CLAUDE_MODEL: "sonnet",
		},
	},
	metadata: {
		description: "Claude Code coding agent",
	},
});
