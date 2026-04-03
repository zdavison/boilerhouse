import { defineWorkload, secret } from "@boilerhouse/core";

export default defineWorkload({
	name: "pi",
	version: "2026.4.3",
	image: { dockerfile: "pi/Dockerfile" },
	resources: { vcpus: 2, memory_mb: 2048, disk_gb: 10 },
	network: {
		access: "restricted",
		allowlist: [
			"api.anthropic.com",
		],
		expose: [{ guest: 7880, host_range: [30000, 30099] }],
		websocket: "/ws",
		credentials: [
			{ domain: "api.anthropic.com", headers: { "x-api-key": secret("ANTHROPIC_API_KEY") } },
		],
	},
	filesystem: { overlay_dirs: ["/workspace", "/root"] },
	idle: { timeout_seconds: 60, action: "hibernate" },
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
			PI_MODEL: "sonnet",
			PI_PROVIDER: "anthropic",
		},
	},
	metadata: {
		description: "Pi coding agent with WebSocket bridge",
	},
});
