import { describe, expect, test } from "bun:test";
import {
	validateWorkload,
	WorkloadParseError,
	defineWorkload,
	resolveWorkloadConfig,
	secret,
	isSecretRef,
	type WorkloadConfig,
	type Workload,
} from "./workload";

// ── Minimal canonical workload (DB shape) ───────────────────────────────────

const MINIMAL: Workload = {
	workload: { name: "my-service", version: "1.0.0" },
	image: { ref: "ghcr.io/org/my-service:latest" },
	resources: { vcpus: 2, memory_mb: 512, disk_gb: 2 },
	network: { access: "none" },
	idle: { action: "hibernate" },
};

// ── validateWorkload() ──────────────────────────────────────────────────────

describe("validateWorkload()", () => {
	test("validates a minimal valid workload (only required fields)", () => {
		const workload = validateWorkload({
			workload: { name: "my-service", version: "1.0.0" },
			image: { ref: "ghcr.io/org/my-service:latest" },
			resources: { vcpus: 2, memory_mb: 512 },
		});

		expect(workload.workload.name).toBe("my-service");
		expect(workload.workload.version).toBe("1.0.0");
		expect(workload.image.ref).toBe("ghcr.io/org/my-service:latest");
		expect(workload.image.dockerfile).toBeUndefined();
		expect(workload.resources.vcpus).toBe(2);
		expect(workload.resources.memory_mb).toBe(512);
		// Defaults
		expect(workload.resources.disk_gb).toBe(2);
		expect(workload.network.access).toBe("none");
		expect(workload.idle.action).toBe("hibernate");
	});

	test("validates a full workload (all optional fields present)", () => {
		const workload = validateWorkload({
			workload: { name: "my-service", version: "1.0.0" },
			image: { ref: "ghcr.io/org/my-service:latest" },
			resources: { vcpus: 2, memory_mb: 512, disk_gb: 4 },
			network: {
				access: "restricted",
				allowlist: ["api.openai.com", "*.amazonaws.com", "ghcr.io"],
				expose: [{ guest: 8080, host_range: [30000, 39999] }],
			},
			filesystem: {
				overlay_dirs: ["/var/data", "/tmp"],
			},
			idle: {
				watch_dirs: ["/var/data", "/tmp/work"],
				timeout_seconds: 300,
				action: "hibernate",
			},
			health: {
				interval_seconds: 10,
				unhealthy_threshold: 3,
				http_get: { path: "/health", port: 8080 },
			},
			entrypoint: {
				cmd: "/usr/bin/my-service",
				args: ["--port", "8080"],
				env: { MODE: "production" },
			},
			metadata: {
				description: "My stateful service",
				team: "platform",
			},
		});

		expect(workload.workload.name).toBe("my-service");
		expect(workload.resources.disk_gb).toBe(4);
		expect(workload.network.access).toBe("restricted");
		expect(workload.network.allowlist).toEqual(["api.openai.com", "*.amazonaws.com", "ghcr.io"]);
		expect(workload.network.expose).toHaveLength(1);
		expect(workload.network.expose![0]!.guest).toBe(8080);
		expect(workload.filesystem!.overlay_dirs).toEqual(["/var/data", "/tmp"]);
		expect(workload.idle.watch_dirs).toEqual(["/var/data", "/tmp/work"]);
		expect(workload.health!.http_get).toEqual({ path: "/health", port: 8080 });
		expect(workload.entrypoint!.cmd).toBe("/usr/bin/my-service");
		expect(workload.metadata).toEqual({ description: "My stateful service", team: "platform" });
	});

	test("rejects missing required fields (name)", () => {
		expect(() => validateWorkload({
			workload: { version: "1.0.0" },
			image: { ref: "test:latest" },
			resources: { vcpus: 2, memory_mb: 512 },
		})).toThrow(WorkloadParseError);
	});

	test("rejects missing required fields (version)", () => {
		expect(() => validateWorkload({
			workload: { name: "my-service" },
			image: { ref: "test:latest" },
			resources: { vcpus: 2, memory_mb: 512 },
		})).toThrow(WorkloadParseError);
	});

	test("rejects missing image source (no ref or dockerfile)", () => {
		expect(() => validateWorkload({
			workload: { name: "my-service", version: "1.0.0" },
			image: {},
			resources: { vcpus: 2, memory_mb: 512 },
		})).toThrow(WorkloadParseError);
	});

	test("rejects image.ref + image.dockerfile both set (mutually exclusive)", () => {
		expect(() => validateWorkload({
			workload: { name: "my-service", version: "1.0.0" },
			image: { ref: "test:latest", dockerfile: "./Dockerfile" },
			resources: { vcpus: 2, memory_mb: 512 },
		})).toThrow(/mutually exclusive/i);
	});

	test("rejects invalid network access values", () => {
		expect(() => validateWorkload({
			workload: { name: "my-service", version: "1.0.0" },
			image: { ref: "test:latest" },
			resources: { vcpus: 2, memory_mb: 512 },
			network: { access: "full" },
		})).toThrow(WorkloadParseError);
	});

	test("rejects negative resource values", () => {
		expect(() => validateWorkload({
			workload: { name: "my-service", version: "1.0.0" },
			image: { ref: "test:latest" },
			resources: { vcpus: -1, memory_mb: 512 },
		})).toThrow(WorkloadParseError);
	});

	test("rejects zero resource values", () => {
		expect(() => validateWorkload({
			workload: { name: "my-service", version: "1.0.0" },
			image: { ref: "test:latest" },
			resources: { vcpus: 2, memory_mb: 0 },
		})).toThrow(WorkloadParseError);
	});

	test("validates wildcard allowlist entries", () => {
		const workload = validateWorkload({
			workload: { name: "my-service", version: "1.0.0" },
			image: { ref: "test:latest" },
			resources: { vcpus: 2, memory_mb: 512 },
			network: {
				access: "restricted",
				allowlist: ["*.amazonaws.com", "api.openai.com"],
			},
		});
		expect(workload.network.allowlist).toContain("*.amazonaws.com");
		expect(workload.network.allowlist).toContain("api.openai.com");
	});

	test("applies defaults: disk_gb=2, network.access='none', idle.action='hibernate'", () => {
		const workload = validateWorkload({
			workload: { name: "my-service", version: "1.0.0" },
			image: { ref: "test:latest" },
			resources: { vcpus: 2, memory_mb: 512 },
		});

		expect(workload.resources.disk_gb).toBe(2);
		expect(workload.network.access).toBe("none");
		expect(workload.idle.action).toBe("hibernate");
	});

	test("preserves metadata passthrough (arbitrary key-value)", () => {
		const workload = validateWorkload({
			workload: { name: "my-service", version: "1.0.0" },
			image: { ref: "test:latest" },
			resources: { vcpus: 2, memory_mb: 512 },
			metadata: { custom_key: "custom_value", another: "field", number_val: 42 },
		});
		expect(workload.metadata).toEqual({
			custom_key: "custom_value",
			another: "field",
			number_val: 42,
		});
	});

	test("validates http_get probe without optional port", () => {
		const workload = validateWorkload({
			workload: { name: "my-service", version: "1.0.0" },
			image: { ref: "test:latest" },
			resources: { vcpus: 2, memory_mb: 512 },
			health: { interval_seconds: 5, unhealthy_threshold: 3, http_get: { path: "/ready" } },
		});
		expect(workload.health!.http_get!.path).toBe("/ready");
		expect(workload.health!.http_get!.port).toBeUndefined();
	});

	test("validates exec probe", () => {
		const workload = validateWorkload({
			workload: { name: "my-service", version: "1.0.0" },
			image: { ref: "test:latest" },
			resources: { vcpus: 2, memory_mb: 512 },
			health: { interval_seconds: 10, unhealthy_threshold: 3, exec: { command: ["cat", "/tmp/healthy"] } },
		});
		expect(workload.health!.exec!.command).toEqual(["cat", "/tmp/healthy"]);
		expect(workload.health!.http_get).toBeUndefined();
	});

	test("rejects health with both http_get and exec (mutually exclusive)", () => {
		expect(() => validateWorkload({
			workload: { name: "my-service", version: "1.0.0" },
			image: { ref: "test:latest" },
			resources: { vcpus: 2, memory_mb: 512 },
			health: {
				interval_seconds: 10, unhealthy_threshold: 3,
				http_get: { path: "/health" },
				exec: { command: ["cat", "/tmp/healthy"] },
			},
		})).toThrow(/mutually exclusive/i);
	});

	test("rejects health section with no probe type", () => {
		expect(() => validateWorkload({
			workload: { name: "my-service", version: "1.0.0" },
			image: { ref: "test:latest" },
			resources: { vcpus: 2, memory_mb: 512 },
			health: { interval_seconds: 10, unhealthy_threshold: 3 },
		})).toThrow(/http_get.*exec|exec.*http_get/i);
	});

	test("accepts workload with dockerfile instead of ref", () => {
		const workload = validateWorkload({
			workload: { name: "my-service", version: "1.0.0" },
			image: { dockerfile: "./Dockerfile" },
			resources: { vcpus: 2, memory_mb: 512 },
		});
		expect(workload.image.dockerfile).toBe("./Dockerfile");
		expect(workload.image.ref).toBeUndefined();
	});

	test("validates credential rules with domain + headers", () => {
		const workload = validateWorkload({
			workload: { name: "my-service", version: "1.0.0" },
			image: { ref: "test:latest" },
			resources: { vcpus: 2, memory_mb: 512 },
			network: {
				access: "restricted",
				allowlist: ["api.anthropic.com"],
				credentials: [{
					domain: "api.anthropic.com",
					headers: { "x-api-key": "${global-secret:ANTHROPIC_API_KEY}" },
				}],
			},
		});
		expect(workload.network.credentials).toHaveLength(1);
		expect(workload.network.credentials![0]!.domain).toBe("api.anthropic.com");
		expect(workload.network.credentials![0]!.headers).toEqual({
			"x-api-key": "${global-secret:ANTHROPIC_API_KEY}",
		});
	});

	test("validates multiple credential entries", () => {
		const workload = validateWorkload({
			workload: { name: "my-service", version: "1.0.0" },
			image: { ref: "test:latest" },
			resources: { vcpus: 2, memory_mb: 512 },
			network: {
				access: "outbound",
				credentials: [
					{ domain: "api.anthropic.com", headers: { "x-api-key": "key1" } },
					{ domain: "api.openai.com", headers: { Authorization: "Bearer key2" } },
				],
			},
		});
		expect(workload.network.credentials).toHaveLength(2);
		expect(workload.network.credentials![0]!.domain).toBe("api.anthropic.com");
		expect(workload.network.credentials![1]!.domain).toBe("api.openai.com");
	});

	test("rejects credentials when network.access = 'none'", () => {
		expect(() => validateWorkload({
			workload: { name: "my-service", version: "1.0.0" },
			image: { ref: "test:latest" },
			resources: { vcpus: 2, memory_mb: 512 },
			network: {
				access: "none",
				credentials: [{
					domain: "api.anthropic.com",
					headers: { "x-api-key": "key" },
				}],
			},
		})).toThrow(/credentials.*none/i);
	});

	test("rejects credential domain not in allowlist (restricted access)", () => {
		expect(() => validateWorkload({
			workload: { name: "my-service", version: "1.0.0" },
			image: { ref: "test:latest" },
			resources: { vcpus: 2, memory_mb: 512 },
			network: {
				access: "restricted",
				allowlist: ["api.openai.com"],
				credentials: [{
					domain: "api.anthropic.com",
					headers: { "x-api-key": "key" },
				}],
			},
		})).toThrow(/allowlist/i);
	});

	test("accepts credentials with outbound access (no allowlist needed)", () => {
		const workload = validateWorkload({
			workload: { name: "my-service", version: "1.0.0" },
			image: { ref: "test:latest" },
			resources: { vcpus: 2, memory_mb: 512 },
			network: {
				access: "outbound",
				credentials: [{
					domain: "api.anthropic.com",
					headers: { "x-api-key": "key" },
				}],
			},
		});
		expect(workload.network.credentials).toHaveLength(1);
	});
});

// ── secret() and isSecretRef() ──────────────────────────────────────────────

describe("secret() and isSecretRef()", () => {
	test("secret() creates a SecretRef with the given name", () => {
		const ref = secret("ANTHROPIC_API_KEY");
		expect(ref.name).toBe("ANTHROPIC_API_KEY");
		expect(isSecretRef(ref)).toBe(true);
	});

	test("isSecretRef() returns false for plain strings", () => {
		expect(isSecretRef("some-string")).toBe(false);
	});

	test("isSecretRef() returns false for plain objects", () => {
		expect(isSecretRef({ name: "KEY" })).toBe(false);
	});

	test("isSecretRef() returns false for null/undefined", () => {
		expect(isSecretRef(null)).toBe(false);
		expect(isSecretRef(undefined)).toBe(false);
	});
});

// ── defineWorkload() + resolveWorkloadConfig() ──────────────────────────────

describe("defineWorkload() + resolveWorkloadConfig()", () => {
	const MINIMAL_CONFIG: WorkloadConfig = {
		name: "my-service",
		version: "1.0.0",
		image: { ref: "ghcr.io/org/my-service:latest" },
		resources: { vcpus: 2, memory_mb: 512 },
	};

	test("defineWorkload() returns the config unchanged (identity)", () => {
		const config = defineWorkload(MINIMAL_CONFIG);
		expect(config).toEqual(MINIMAL_CONFIG);
	});

	test("minimal config resolves to a valid Workload", () => {
		const workload = resolveWorkloadConfig(MINIMAL_CONFIG);

		expect(workload.workload.name).toBe("my-service");
		expect(workload.workload.version).toBe("1.0.0");
		expect(workload.image.ref).toBe("ghcr.io/org/my-service:latest");
		expect(workload.resources.vcpus).toBe(2);
		expect(workload.resources.memory_mb).toBe(512);
	});

	test("applies defaults: disk_gb=2, network.access='none', idle.action='hibernate'", () => {
		const workload = resolveWorkloadConfig(MINIMAL_CONFIG);

		expect(workload.resources.disk_gb).toBe(2);
		expect(workload.network.access).toBe("none");
		expect(workload.idle.action).toBe("hibernate");
	});

	test("serializes SecretRef in credential headers to ${global-secret:NAME}", () => {
		const config = defineWorkload({
			name: "my-service",
			version: "1.0.0",
			image: { ref: "ghcr.io/org/my-service:latest" },
			resources: { vcpus: 2, memory_mb: 512 },
			network: {
				access: "restricted",
				allowlist: ["api.anthropic.com"],
				credentials: [{
					domain: "api.anthropic.com",
					headers: {
						"x-api-key": secret("ANTHROPIC_API_KEY"),
					},
				}],
			},
		});

		const workload = resolveWorkloadConfig(config);

		expect(workload.network.credentials).toHaveLength(1);
		expect(workload.network.credentials![0]!.headers["x-api-key"]).toBe(
			"${global-secret:ANTHROPIC_API_KEY}",
		);
	});

	test("passes through plain string header values alongside SecretRef", () => {
		const config = defineWorkload({
			name: "my-service",
			version: "1.0.0",
			image: { ref: "ghcr.io/org/my-service:latest" },
			resources: { vcpus: 2, memory_mb: 512 },
			network: {
				access: "outbound",
				credentials: [{
					domain: "api.example.com",
					headers: {
						"x-api-key": secret("KEY"),
						"x-custom": "literal-value",
					},
				}],
			},
		});

		const workload = resolveWorkloadConfig(config);
		const headers = workload.network.credentials![0]!.headers;

		expect(headers["x-api-key"]).toBe("${global-secret:KEY}");
		expect(headers["x-custom"]).toBe("literal-value");
	});

	test("rejects image.ref + image.dockerfile (mutually exclusive)", () => {
		const config: WorkloadConfig = {
			name: "bad",
			version: "1.0.0",
			image: { ref: "test:latest", dockerfile: "./Dockerfile" },
			resources: { vcpus: 1, memory_mb: 256 },
		};

		expect(() => resolveWorkloadConfig(config)).toThrow(/mutually exclusive/i);
	});

	test("rejects missing image source (no ref or dockerfile)", () => {
		const config: WorkloadConfig = {
			name: "bad",
			version: "1.0.0",
			image: {},
			resources: { vcpus: 1, memory_mb: 256 },
		};

		expect(() => resolveWorkloadConfig(config)).toThrow(WorkloadParseError);
	});

	test("rejects health with both http_get and exec", () => {
		const config: WorkloadConfig = {
			name: "bad",
			version: "1.0.0",
			image: { ref: "test:latest" },
			resources: { vcpus: 1, memory_mb: 256 },
			health: {
				interval_seconds: 10,
				unhealthy_threshold: 3,
				http_get: { path: "/health" },
				exec: { command: ["cat", "/tmp/healthy"] },
			},
		};

		expect(() => resolveWorkloadConfig(config)).toThrow(/mutually exclusive/i);
	});

	test("rejects credential domain not in allowlist (restricted)", () => {
		const config: WorkloadConfig = {
			name: "bad",
			version: "1.0.0",
			image: { ref: "test:latest" },
			resources: { vcpus: 1, memory_mb: 256 },
			network: {
				access: "restricted",
				allowlist: ["api.openai.com"],
				credentials: [{
					domain: "api.anthropic.com",
					headers: { "x-api-key": "key" },
				}],
			},
		};

		expect(() => resolveWorkloadConfig(config)).toThrow(/allowlist/i);
	});

	test("resolves full config with all optional fields", () => {
		const config = defineWorkload({
			name: "full-service",
			version: "2.0.0",
			image: { ref: "ghcr.io/org/full:latest" },
			resources: { vcpus: 4, memory_mb: 4096, disk_gb: 20 },
			network: {
				access: "restricted",
				allowlist: ["api.openai.com", "*.amazonaws.com"],
				expose: [{ guest: 8080, host_range: [30000, 39999] }],
			},
			filesystem: {
				overlay_dirs: ["/var/data"],
			},
			idle: {
				watch_dirs: ["/var/data"],
				timeout_seconds: 300,
				action: "hibernate",
			},
			health: {
				interval_seconds: 10,
				unhealthy_threshold: 3,
				http_get: { path: "/health", port: 8080 },
			},
			entrypoint: {
				cmd: "/usr/bin/server",
				args: ["--port", "8080"],
				env: { MODE: "production" },
				workdir: "/app",
			},
			metadata: { team: "platform" },
		});

		const workload = resolveWorkloadConfig(config);

		expect(workload.workload.name).toBe("full-service");
		expect(workload.resources.disk_gb).toBe(20);
		expect(workload.network.access).toBe("restricted");
		expect(workload.network.expose).toHaveLength(1);
		expect(workload.filesystem!.overlay_dirs).toEqual(["/var/data"]);
		expect(workload.idle.timeout_seconds).toBe(300);
		expect(workload.health!.http_get!.path).toBe("/health");
		expect(workload.entrypoint!.cmd).toBe("/usr/bin/server");
		expect(workload.entrypoint!.workdir).toBe("/app");
		expect(workload.metadata).toEqual({ team: "platform" });
	});
});
