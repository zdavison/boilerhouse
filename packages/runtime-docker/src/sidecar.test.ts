import { describe, test, expect, beforeEach } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DockerClient } from "./client";
import type { ContainerCreateBody } from "./client";
import { DockerRuntimeError } from "./errors";
import { DockerSidecar } from "./sidecar";

interface MockCall<T = unknown[]> {
	args: T;
}

function createMockClient() {
	const calls = {
		createContainer: [] as MockCall<[string, ContainerCreateBody]>[],
		startContainer: [] as MockCall<[string]>[],
		waitContainer: [] as MockCall<[string]>[],
		containerLogs: [] as MockCall<[string, number]>[],
		removeContainer: [] as MockCall<[string]>[],
	};

	let waitResult: { StatusCode: number } = { StatusCode: 0 };
	let logsResult = "";

	const client = {
		createContainer: async (name: string, body: ContainerCreateBody) => {
			calls.createContainer.push({ args: [name, body] });
			return "fake-container-id";
		},
		startContainer: async (id: string) => {
			calls.startContainer.push({ args: [id] });
		},
		waitContainer: async (id: string) => {
			calls.waitContainer.push({ args: [id] });
			return waitResult;
		},
		containerLogs: async (id: string, tail: number) => {
			calls.containerLogs.push({ args: [id, tail] });
			return logsResult;
		},
		removeContainer: async (id: string) => {
			calls.removeContainer.push({ args: [id] });
		},
	} as unknown as DockerClient;

	return {
		client,
		calls,
		setWaitResult: (result: { StatusCode: number }) => { waitResult = result; },
		setLogsResult: (result: string) => { logsResult = result; },
	};
}

describe("DockerSidecar", () => {
	let mock: ReturnType<typeof createMockClient>;
	let sidecar: DockerSidecar;
	const instanceId = "test-instance-123";

	beforeEach(() => {
		mock = createMockClient();
		sidecar = new DockerSidecar(mock.client);
	});

	describe("create()", () => {
		test("proxy container has ReadonlyRootfs enabled", async () => {
			await sidecar.create(instanceId, { proxyConfig: "static_resources: {}" });

			const [, proxyBody] = mock.calls.createContainer[0]!.args;
			expect(proxyBody.HostConfig.ReadonlyRootfs).toBe(true);
		});

		test("iptables init blocks link-local range (covers metadata server)", async () => {
			await sidecar.create(instanceId, { proxyConfig: "config" });

			const [, initBody] = mock.calls.createContainer[1]!.args;
			const script = (initBody.Cmd as string[]).join(" ");
			expect(script).toContain("169.254.0.0/16");
			expect(script).toContain("DROP");
		});

		test("creates proxy and iptables-init containers with correct network mode", async () => {
			await sidecar.create(instanceId, { proxyConfig: "static_resources: {}" });

			expect(mock.calls.createContainer).toHaveLength(2);

			const [proxyName, proxyBody] = mock.calls.createContainer[0]!.args;
			expect(proxyName).toBe(`${instanceId}-proxy`);
			expect(proxyBody.HostConfig.NetworkMode).toBe(`container:${instanceId}`);
			expect(proxyBody.Image).toContain("envoy");

			const [initName, initBody] = mock.calls.createContainer[1]!.args;
			expect(initName).toBe(`${instanceId}-iptables-init`);
			expect(initBody.HostConfig.NetworkMode).toBe(`container:${instanceId}`);
			expect(initBody.HostConfig.CapAdd).toContain("NET_ADMIN");
		});

		test("writes envoy config to temp file", async () => {
			const config = "admin:\n  address:\n    socket_address:\n      port_value: 9901";
			const state = await sidecar.create(instanceId, { proxyConfig: config });

			expect(state.configPath).toContain(instanceId);
			expect(existsSync(state.configPath)).toBe(true);
			expect(readFileSync(state.configPath, "utf-8")).toBe(config);

			// Verify the config path is bind-mounted into the proxy container
			const [, proxyBody] = mock.calls.createContainer[0]!.args;
			expect(proxyBody.HostConfig.Binds).toContainEqual(
				`${state.configPath}:/etc/envoy/envoy.yaml:ro`,
			);
		});

		test("writes TLS certs when proxyCerts provided", async () => {
			const state = await sidecar.create(instanceId, {
				proxyConfig: "config",
				proxyCerts: [
					{ domain: "example.com", cert: "CERT_DATA", key: "KEY_DATA" },
					{ domain: "*.wildcard.io", cert: "WILD_CERT", key: "WILD_KEY" },
				],
			});

			expect(state.certsDir).toBeDefined();
			expect(existsSync(state.certsDir!)).toBe(true);

			const files = readdirSync(state.certsDir!);
			expect(files).toContain("example_com.crt");
			expect(files).toContain("example_com.key");
			expect(readFileSync(join(state.certsDir!, "example_com.crt"), "utf-8")).toBe("CERT_DATA");
			expect(readFileSync(join(state.certsDir!, "example_com.key"), "utf-8")).toBe("KEY_DATA");

			// Wildcard domains: leading dots/stars replaced, leading underscores stripped
			expect(files).toContain("wildcard_io.crt");
			expect(files).toContain("wildcard_io.key");

			// Verify certs dir is bind-mounted
			const [, proxyBody] = mock.calls.createContainer[0]!.args;
			expect(proxyBody.HostConfig.Binds).toContainEqual(
				`${state.certsDir}:/etc/envoy/certs:ro`,
			);
		});

		test("returns SidecarState with correct paths", async () => {
			const state = await sidecar.create(instanceId, { proxyConfig: "cfg" });

			expect(state.configPath).toStartWith(join(tmpdir(), `boilerhouse-${instanceId}`));
			expect(state.certsDir).toBeUndefined();
		});

		test("returns SidecarState with certsDir when proxyCerts provided", async () => {
			const state = await sidecar.create(instanceId, {
				proxyConfig: "cfg",
				proxyCerts: [{ domain: "a.com", cert: "c", key: "k" }],
			});

			expect(state.configPath).toBeDefined();
			expect(state.certsDir).toBeDefined();
			expect(state.certsDir).toStartWith(join(tmpdir(), `boilerhouse-${instanceId}-certs-`));
		});
	});

	describe("start()", () => {
		test("starts proxy container", async () => {
			await sidecar.start(instanceId);

			expect(mock.calls.startContainer[0]!.args[0]).toBe(`${instanceId}-proxy`);
		});

		test("starts and waits for iptables init", async () => {
			await sidecar.start(instanceId);

			expect(mock.calls.startContainer[1]!.args[0]).toBe(`${instanceId}-iptables-init`);
			expect(mock.calls.waitContainer[0]!.args[0]).toBe(`${instanceId}-iptables-init`);
		});

		test("removes init container after success", async () => {
			mock.setWaitResult({ StatusCode: 0 });
			await sidecar.start(instanceId);

			expect(mock.calls.removeContainer).toHaveLength(1);
			expect(mock.calls.removeContainer[0]!.args[0]).toBe(`${instanceId}-iptables-init`);
		});

		test("throws DockerRuntimeError when iptables init fails", async () => {
			mock.setWaitResult({ StatusCode: 1 });
			mock.setLogsResult("iptables: No chain/target/match by that name");

			await expect(sidecar.start(instanceId)).rejects.toThrow(DockerRuntimeError);
			await expect(sidecar.start(instanceId)).rejects.toThrow(/iptables init failed/);

			// Should have fetched logs for the failing container
			expect(mock.calls.containerLogs.length).toBeGreaterThan(0);
			expect(mock.calls.containerLogs[0]!.args[0]).toBe(`${instanceId}-iptables-init`);
		});

		test("does not remove init container on failure", async () => {
			mock.setWaitResult({ StatusCode: 1 });
			mock.setLogsResult("error");

			try { await sidecar.start(instanceId); } catch { /* expected */ }

			// removeContainer should not have been called (init failed before removal)
			expect(mock.calls.removeContainer).toHaveLength(0);
		});
	});

	describe("destroy()", () => {
		test("removes proxy container", async () => {
			const state = await sidecar.create(instanceId, { proxyConfig: "cfg" });
			await sidecar.destroy(instanceId, state);

			expect(mock.calls.removeContainer).toHaveLength(1);
			expect(mock.calls.removeContainer[0]!.args[0]).toBe(`${instanceId}-proxy`);
		});

		test("cleans up temp files", async () => {
			const state = await sidecar.create(instanceId, {
				proxyConfig: "cfg",
				proxyCerts: [{ domain: "test.com", cert: "c", key: "k" }],
			});

			expect(existsSync(state.configPath)).toBe(true);
			expect(existsSync(state.certsDir!)).toBe(true);

			await sidecar.destroy(instanceId, state);

			expect(existsSync(state.configPath)).toBe(false);
			expect(existsSync(state.certsDir!)).toBe(false);
		});
	});

	describe("blockMetadataServer()", () => {
		test("creates, starts, waits, and removes an init container", async () => {
			await sidecar.blockMetadataServer(instanceId);

			const name = `${instanceId}-metadata-block`;
			expect(mock.calls.createContainer[0]?.args[0]).toBe(name);
			expect(mock.calls.startContainer[0]?.args[0]).toBe(name);
			expect(mock.calls.waitContainer[0]?.args[0]).toBe(name);
			expect(mock.calls.removeContainer[0]?.args[0]).toBe(name);
		});

		test("init container shares workload network namespace and has NET_ADMIN cap", async () => {
			await sidecar.blockMetadataServer(instanceId);

			const [, body] = mock.calls.createContainer[0]!.args;
			expect(body.HostConfig.NetworkMode).toBe(`container:${instanceId}`);
			expect(body.HostConfig.CapAdd).toContain("NET_ADMIN");
			expect(body.HostConfig.CapDrop).toContain("ALL");
		});

		test("init command drops link-local range", async () => {
			await sidecar.blockMetadataServer(instanceId);

			const [, body] = mock.calls.createContainer[0]!.args;
			const script = (body.Cmd as string[]).join(" ");
			expect(script).toContain("169.254.0.0/16");
			expect(script).toContain("DROP");
		});

		test("throws DockerRuntimeError when init exits non-zero", async () => {
			mock.setWaitResult({ StatusCode: 1 });
			mock.setLogsResult("iptables error");

			await expect(sidecar.blockMetadataServer(instanceId)).rejects.toThrow(DockerRuntimeError);
		});
	});

	describe("prepareCaCert()", () => {
		test("writes cert file and returns correct binds/env", () => {
			const certPem = "-----BEGIN CERTIFICATE-----\nMIIBfake...\n-----END CERTIFICATE-----";
			const result = sidecar.prepareCaCert(instanceId, certPem);

			expect(result.caCertPath).toContain(instanceId);
			expect(existsSync(result.caCertPath)).toBe(true);
			expect(readFileSync(result.caCertPath, "utf-8")).toBe(certPem);

			expect(result.binds).toEqual([
				`${result.caCertPath}:/etc/boilerhouse/proxy-ca.crt:ro`,
			]);
			expect(result.env).toEqual({
				NODE_EXTRA_CA_CERTS: "/etc/boilerhouse/proxy-ca.crt",
			});

			// Clean up
			try { require("node:fs").unlinkSync(result.caCertPath); } catch { /* */ }
		});
	});
});
