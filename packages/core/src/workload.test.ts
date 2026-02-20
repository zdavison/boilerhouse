import { describe, expect, test } from "bun:test";
import { parseWorkload, WorkloadParseError } from "./workload";

const MINIMAL_TOML = `
[workload]
name = "my-service"
version = "1.0.0"

[image]
ref = "ghcr.io/org/my-service:latest"

[resources]
vcpus = 2
memory_mb = 512
`;

const FULL_TOML = `
[workload]
name = "my-service"
version = "1.0.0"

[image]
ref = "ghcr.io/org/my-service:latest"

[resources]
vcpus = 2
memory_mb = 512
disk_gb = 4

[network]
access = "restricted"
allowlist = ["api.openai.com", "*.amazonaws.com", "ghcr.io"]
expose = [{ guest = 8080, host_range = [30000, 39999] }]

[filesystem]
overlay_dirs = ["/var/data", "/tmp"]
bind_mounts = [
  { host = "/srv/shared-assets", guest = "/assets", readonly = true }
]

[idle]
watch_dirs = ["/var/data", "/tmp/work"]
timeout_seconds = 300
action = "hibernate"

[health]
interval_seconds = 10
unhealthy_threshold = 3

[health.http_get]
path = "/health"
port = 8080

[entrypoint]
cmd = "/usr/bin/my-service"
args = ["--port", "8080"]
env = { MODE = "production" }

[metadata]
description = "My stateful service"
team = "platform"
`;

describe("workload TOML parser", () => {
	test("parses a minimal valid workload TOML (only required fields)", () => {
		const workload = parseWorkload(MINIMAL_TOML);

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

	test("parses a full workload TOML (all optional fields present)", () => {
		const workload = parseWorkload(FULL_TOML);

		expect(workload.workload.name).toBe("my-service");
		expect(workload.workload.version).toBe("1.0.0");
		expect(workload.image.ref).toBe("ghcr.io/org/my-service:latest");
		expect(workload.resources.disk_gb).toBe(4);
		expect(workload.network.access).toBe("restricted");
		expect(workload.network.allowlist).toEqual([
			"api.openai.com",
			"*.amazonaws.com",
			"ghcr.io",
		]);
		expect(workload.network.expose).toHaveLength(1);
		expect(workload.network.expose![0]!.guest).toBe(8080);
		expect(workload.network.expose![0]!.host_range).toEqual([30000, 39999]);
		expect(workload.filesystem!.overlay_dirs).toEqual(["/var/data", "/tmp"]);
		expect(workload.filesystem!.bind_mounts).toHaveLength(1);
		expect(workload.idle.watch_dirs).toEqual(["/var/data", "/tmp/work"]);
		expect(workload.idle.timeout_seconds).toBe(300);
		expect(workload.idle.action).toBe("hibernate");
		expect(workload.health!.interval_seconds).toBe(10);
		expect(workload.health!.unhealthy_threshold).toBe(3);
		expect(workload.health!.http_get).toEqual({ path: "/health", port: 8080 });
		expect(workload.health!.exec).toBeUndefined();
		expect(workload.entrypoint!.cmd).toBe("/usr/bin/my-service");
		expect(workload.entrypoint!.args).toEqual(["--port", "8080"]);
		expect(workload.entrypoint!.env).toEqual({ MODE: "production" });
		expect(workload.metadata).toEqual({
			description: "My stateful service",
			team: "platform",
		});
	});

	test("rejects missing required fields (name)", () => {
		const toml = `
[workload]
version = "1.0.0"

[image]
ref = "ghcr.io/org/my-service:latest"

[resources]
vcpus = 2
memory_mb = 512
`;
		expect(() => parseWorkload(toml)).toThrow(WorkloadParseError);
	});

	test("rejects missing required fields (version)", () => {
		const toml = `
[workload]
name = "my-service"

[image]
ref = "ghcr.io/org/my-service:latest"

[resources]
vcpus = 2
memory_mb = 512
`;
		expect(() => parseWorkload(toml)).toThrow(WorkloadParseError);
	});

	test("rejects missing required fields (image.ref when no dockerfile)", () => {
		const toml = `
[workload]
name = "my-service"
version = "1.0.0"

[image]

[resources]
vcpus = 2
memory_mb = 512
`;
		expect(() => parseWorkload(toml)).toThrow(WorkloadParseError);
	});

	test("rejects invalid combinations (image.ref + image.dockerfile both set)", () => {
		const toml = `
[workload]
name = "my-service"
version = "1.0.0"

[image]
ref = "ghcr.io/org/my-service:latest"
dockerfile = "./Dockerfile"

[resources]
vcpus = 2
memory_mb = 512
`;
		expect(() => parseWorkload(toml)).toThrow(WorkloadParseError);
		expect(() => parseWorkload(toml)).toThrow(
			/mutually exclusive/i,
		);
	});

	test("rejects invalid network access values", () => {
		const toml = `
[workload]
name = "my-service"
version = "1.0.0"

[image]
ref = "ghcr.io/org/my-service:latest"

[resources]
vcpus = 2
memory_mb = 512

[network]
access = "full"
`;
		expect(() => parseWorkload(toml)).toThrow(WorkloadParseError);
	});

	test("rejects negative resource values", () => {
		const toml = `
[workload]
name = "my-service"
version = "1.0.0"

[image]
ref = "ghcr.io/org/my-service:latest"

[resources]
vcpus = -1
memory_mb = 512
`;
		expect(() => parseWorkload(toml)).toThrow(WorkloadParseError);
	});

	test("rejects zero resource values", () => {
		const toml = `
[workload]
name = "my-service"
version = "1.0.0"

[image]
ref = "ghcr.io/org/my-service:latest"

[resources]
vcpus = 2
memory_mb = 0
`;
		expect(() => parseWorkload(toml)).toThrow(WorkloadParseError);
	});

	test("parses wildcard allowlist entries (*.amazonaws.com)", () => {
		const toml = `
[workload]
name = "my-service"
version = "1.0.0"

[image]
ref = "ghcr.io/org/my-service:latest"

[resources]
vcpus = 2
memory_mb = 512

[network]
access = "restricted"
allowlist = ["*.amazonaws.com", "api.openai.com"]
`;
		const workload = parseWorkload(toml);
		expect(workload.network.allowlist).toContain("*.amazonaws.com");
		expect(workload.network.allowlist).toContain("api.openai.com");
	});

	test("defaults: disk_gb=2, network.access='none', idle.action='hibernate'", () => {
		const workload = parseWorkload(MINIMAL_TOML);

		expect(workload.resources.disk_gb).toBe(2);
		expect(workload.network.access).toBe("none");
		expect(workload.idle.action).toBe("hibernate");
	});

	test("preserves metadata passthrough (arbitrary key-value)", () => {
		const toml = `
[workload]
name = "my-service"
version = "1.0.0"

[image]
ref = "ghcr.io/org/my-service:latest"

[resources]
vcpus = 2
memory_mb = 512

[metadata]
custom_key = "custom_value"
another = "field"
number_val = 42
`;
		const workload = parseWorkload(toml);
		expect(workload.metadata).toEqual({
			custom_key: "custom_value",
			another: "field",
			number_val: 42,
		});
	});

	test("parses http_get probe without optional port", () => {
		const toml = `
[workload]
name = "my-service"
version = "1.0.0"

[image]
ref = "ghcr.io/org/my-service:latest"

[resources]
vcpus = 2
memory_mb = 512

[health]
interval_seconds = 5
unhealthy_threshold = 3

[health.http_get]
path = "/ready"
`;
		const workload = parseWorkload(toml);
		expect(workload.health!.http_get!.path).toBe("/ready");
		expect(workload.health!.http_get!.port).toBeUndefined();
	});

	test("parses exec probe", () => {
		const toml = `
[workload]
name = "my-service"
version = "1.0.0"

[image]
ref = "ghcr.io/org/my-service:latest"

[resources]
vcpus = 2
memory_mb = 512

[health]
interval_seconds = 10
unhealthy_threshold = 3

[health.exec]
command = ["cat", "/tmp/healthy"]
`;
		const workload = parseWorkload(toml);
		expect(workload.health!.exec!.command).toEqual(["cat", "/tmp/healthy"]);
		expect(workload.health!.http_get).toBeUndefined();
	});

	test("rejects health with both http_get and exec (mutually exclusive)", () => {
		const toml = `
[workload]
name = "my-service"
version = "1.0.0"

[image]
ref = "ghcr.io/org/my-service:latest"

[resources]
vcpus = 2
memory_mb = 512

[health]
interval_seconds = 10
unhealthy_threshold = 3

[health.http_get]
path = "/health"

[health.exec]
command = ["cat", "/tmp/healthy"]
`;
		expect(() => parseWorkload(toml)).toThrow(WorkloadParseError);
		expect(() => parseWorkload(toml)).toThrow(/mutually exclusive/i);
	});

	test("rejects health section with no probe type", () => {
		const toml = `
[workload]
name = "my-service"
version = "1.0.0"

[image]
ref = "ghcr.io/org/my-service:latest"

[resources]
vcpus = 2
memory_mb = 512

[health]
interval_seconds = 10
unhealthy_threshold = 3
`;
		expect(() => parseWorkload(toml)).toThrow(WorkloadParseError);
		expect(() => parseWorkload(toml)).toThrow(/http_get.*exec|exec.*http_get/i);
	});

	test("accepts workload with dockerfile instead of ref", () => {
		const toml = `
[workload]
name = "my-service"
version = "1.0.0"

[image]
dockerfile = "./Dockerfile"

[resources]
vcpus = 2
memory_mb = 512
`;
		const workload = parseWorkload(toml);
		expect(workload.image.dockerfile).toBe("./Dockerfile");
		expect(workload.image.ref).toBeUndefined();
	});
});
