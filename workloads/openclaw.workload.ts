import { defineWorkload, secret } from "@boilerhouse/core";

export default defineWorkload({
	name: "openclaw",
	version: "2026.3.13",
	image: { dockerfile: "openclaw/Dockerfile" },
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
			headers: { "x-api-key": secret("ANTHROPIC_API_KEY") },
		}],
	},
	filesystem: { overlay_dirs: ["/home/node/.openclaw"] },
	idle: { timeout_seconds: 600, action: "hibernate" },
	health: {
		interval_seconds: 2,
		unhealthy_threshold: 30,
		http_get: { path: "/__openclaw/control-ui-config.json", port: 18789 },
	},
	entrypoint: {
		workdir: "/app",
		cmd: "/bin/sh",
		args: [
			"-c",
			'mkdir -p /home/node/.openclaw && echo \'{"gateway":{"controlUi":{"dangerouslyAllowHostHeaderOriginFallback":true}}}\' > /home/node/.openclaw/openclaw.json && exec docker-entrypoint.sh node openclaw.mjs gateway --allow-unconfigured --bind lan',
		],
		env: {
			OPENCLAW_GATEWAY_TOKEN: "73307c8aab2b025f959a53f5095c0addec0be76fe4b5d470",
			OPENCLAW_CONFIG_PATH: "/home/node/.openclaw/openclaw.json",
			ANTHROPIC_BASE_URL: "http://host.containers.internal:18080",
			ANTHROPIC_API_KEY: "sk-ant-proxy-managed",
		},
	},
	metadata: {
		description: "OpenClaw autonomous AI agent",
		homepage: "https://github.com/openclaw/openclaw",
		connect_url: "/?token=73307c8aab2b025f959a53f5095c0addec0be76fe4b5d470",
	},
});
