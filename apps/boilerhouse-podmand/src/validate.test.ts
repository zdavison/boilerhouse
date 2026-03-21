import { describe, test, expect } from "bun:test";
import { validateContainerSpec, PolicyViolationError } from "./validate";
import type { ContainerCreateSpec } from "@boilerhouse/runtime-podman";

function validSpec(overrides: Partial<ContainerCreateSpec> = {}): ContainerCreateSpec {
	return {
		name: "test-ctr",
		image: "alpine:3.21",
		portmappings: [{ container_port: 8080, host_port: 0, protocol: "tcp" }],
		cap_drop: ["ALL"],
		cap_add: ["CAP_CHOWN", "CAP_NET_BIND_SERVICE"],
		no_new_privileges: true,
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

	test("rejects missing cap_drop", () => {
		const spec = validSpec({ cap_drop: undefined });
		expect(() => validateContainerSpec(spec)).toThrow(PolicyViolationError);
		expect(() => validateContainerSpec(spec)).toThrow(/cap_drop/i);
	});

	test("rejects cap_drop without ALL", () => {
		const spec = validSpec({ cap_drop: ["CAP_NET_RAW"] });
		expect(() => validateContainerSpec(spec)).toThrow(PolicyViolationError);
		expect(() => validateContainerSpec(spec)).toThrow(/cap_drop/i);
	});

	test("rejects no_new_privileges: false", () => {
		const spec = validSpec({ no_new_privileges: false });
		expect(() => validateContainerSpec(spec)).toThrow(PolicyViolationError);
		expect(() => validateContainerSpec(spec)).toThrow(/no_new_privileges/i);
	});

	test("rejects missing no_new_privileges", () => {
		const spec = validSpec({ no_new_privileges: undefined });
		expect(() => validateContainerSpec(spec)).toThrow(PolicyViolationError);
		expect(() => validateContainerSpec(spec)).toThrow(/no_new_privileges/i);
	});

	test("forces no_new_privileges to true in returned spec", () => {
		const spec = validSpec();
		const result = validateContainerSpec(spec);
		expect(result.no_new_privileges).toBe(true);
	});

	test("preserves cap_drop and cap_add in returned spec", () => {
		const spec = validSpec();
		const result = validateContainerSpec(spec);
		expect(result.cap_drop).toEqual(["ALL"]);
		expect(result.cap_add).toEqual(["CAP_CHOWN", "CAP_NET_BIND_SERVICE"]);
	});
});
