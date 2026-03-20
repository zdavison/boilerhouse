import { describe, test, expect } from "bun:test";
import { validateContainerSpec, PolicyViolationError } from "./validate";
import type { ContainerCreateSpec } from "@boilerhouse/runtime-podman";

function validSpec(overrides: Partial<ContainerCreateSpec> = {}): ContainerCreateSpec {
	return {
		name: "test-ctr",
		image: "alpine:3.21",
		portmappings: [{ container_port: 8080, host_port: 0, protocol: "tcp" }],
		...overrides,
	};
}

describe("validateContainerSpec", () => {
	test("accepts a valid spec with ephemeral ports", () => {
		expect(() => validateContainerSpec(validSpec())).not.toThrow();
	});

	test("accepts a spec with no portmappings", () => {
		expect(() => validateContainerSpec(validSpec({ portmappings: undefined }))).not.toThrow();
	});

	test("accepts a spec with netns: none", () => {
		expect(() => validateContainerSpec(validSpec({ netns: { nsmode: "none" } }))).not.toThrow();
	});

	test("rejects privileged: true", () => {
		expect(() => validateContainerSpec(validSpec({ privileged: true }))).toThrow(PolicyViolationError);
		expect(() => validateContainerSpec(validSpec({ privileged: true }))).toThrow(/privileged/i);
	});

	test("rejects fixed host port (non-zero)", () => {
		const spec = validSpec({
			portmappings: [{ container_port: 8080, host_port: 8080, protocol: "tcp" }],
		});
		expect(() => validateContainerSpec(spec)).toThrow(PolicyViolationError);
		expect(() => validateContainerSpec(spec)).toThrow(/host.?port/i);
	});

	test("rejects host network namespace", () => {
		const spec = validSpec({ netns: { nsmode: "host" } });
		expect(() => validateContainerSpec(spec)).toThrow(PolicyViolationError);
		expect(() => validateContainerSpec(spec)).toThrow(/host.*network/i);
	});

	test("rejects bind mounts from arbitrary paths", () => {
		const spec = validSpec({
			mounts: [{ destination: "/data", type: "bind", source: "/etc/passwd", options: [] }],
		});
		expect(() => validateContainerSpec(spec)).toThrow(PolicyViolationError);
		expect(() => validateContainerSpec(spec)).toThrow(/bind/i);
	});

	test("rejects bind mounts with no source", () => {
		const spec = validSpec({
			mounts: [{ destination: "/data", type: "bind", options: [] }],
		});
		expect(() => validateContainerSpec(spec)).toThrow(PolicyViolationError);
	});

	test("allows bind mounts from allowed source directories", () => {
		const spec = validSpec({
			mounts: [{ destination: "/etc/envoy/envoy.yaml", type: "bind", source: "/var/lib/configs/my-envoy.yaml", options: ["ro"] }],
		});
		expect(() => validateContainerSpec(spec, { allowedBindSources: ["/var/lib/configs"] })).not.toThrow();
	});

	test("rejects bind mounts outside allowed source directories", () => {
		const spec = validSpec({
			mounts: [{ destination: "/etc/envoy/envoy.yaml", type: "bind", source: "/tmp/evil.yaml", options: ["ro"] }],
		});
		expect(() => validateContainerSpec(spec, { allowedBindSources: ["/var/lib/configs"] })).toThrow(PolicyViolationError);
	});

	test("allows tmpfs mounts", () => {
		const spec = validSpec({
			mounts: [{ destination: "/data", type: "tmpfs", options: ["size=256m"] }],
		});
		expect(() => validateContainerSpec(spec)).not.toThrow();
	});

	test("injects managed-by label", () => {
		const spec = validSpec();
		const result = validateContainerSpec(spec);
		expect(result.labels?.["managed-by"]).toBe("boilerhouse-podmand");
	});

	test("preserves existing labels when injecting managed-by", () => {
		const spec = validSpec({ labels: { "boilerhouse.workload": "myapp" } });
		const result = validateContainerSpec(spec);
		expect(result.labels?.["managed-by"]).toBe("boilerhouse-podmand");
		expect(result.labels?.["boilerhouse.workload"]).toBe("myapp");
	});

	test("forces privileged to false in returned spec", () => {
		const spec = validSpec({ privileged: false });
		const result = validateContainerSpec(spec);
		expect(result.privileged).toBe(false);
	});
});
