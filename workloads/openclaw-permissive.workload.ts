// Permissive variant of openclaw.workload.ts.
// Differences from the standard openclaw workload:
//   - name: "openclaw-permissive" (runs as a separate workload)
//   - network.access: "outbound" instead of "restricted" (unrestricted egress,
//     so the agent can apt-get install, pip install, curl, etc.)
//   - network.allowlist: removed (not needed with "outbound" access)
import { defineWorkload, secret } from "@boilerhouse/core";

export const GATEWAY_TOKEN = "73307c8aab2b025f959a53f5095c0addec0be76fe4b5d470";

export default defineWorkload({
	name: "openclaw-permissive",
	version: "2026.3.24",
	image: { dockerfile: "openclaw/Dockerfile" },
	resources: { vcpus: 2, memory_mb: 2048, disk_gb: 10 },
	network: {
		// "outbound" = full egress (vs "restricted" + allowlist in standard openclaw)
		access: "outbound",
		expose: [{ guest: 18789, host_range: [30000, 30099] }],
		websocket: "/",
		credentials: [{
			domain: "api.anthropic.com",
			headers: { "x-api-key": secret("ANTHROPIC_API_KEY") },
		}],
	},
	filesystem: { overlay_dirs: ["/root"] },
	idle: { timeout_seconds: 60, action: "hibernate", watch_dirs: ["/root/.openclaw"] },
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
			'mkdir -p /root/.openclaw && echo \'{"gateway":{"controlUi":{"dangerouslyAllowHostHeaderOriginFallback":true},"http":{"endpoints":{"chatCompletions":{"enabled":true}}}}}\' > /root/.openclaw/openclaw.json && exec docker-entrypoint.sh node openclaw.mjs gateway --allow-unconfigured --bind lan',
		],
		env: {
			OPENCLAW_GATEWAY_TOKEN: GATEWAY_TOKEN,
			OPENCLAW_CONFIG_PATH: "/root/.openclaw/openclaw.json",
			ANTHROPIC_API_KEY: "sk-ant-proxy-managed",
		},
	},
	metadata: {
		description: "OpenClaw autonomous AI agent (permissive networking)",
		homepage: "https://github.com/openclaw/openclaw",
		connect_url: `/#token=${GATEWAY_TOKEN}`,
	},
});
