import { describe, test, expect, afterAll } from "bun:test";
import type { InstanceId, Workload } from "@boilerhouse/core";
import { KubernetesRuntime } from "./runtime";

/**
 * Detect if minikube boilerhouse-test cluster is available.
 */
function k8sAvailable(): boolean {
	try {
		const status = Bun.spawnSync(
			["minikube", "status", "-p", "boilerhouse-test", "-o", "json"],
			{ stdout: "pipe", stderr: "ignore" },
		);
		if (status.exitCode !== 0) return false;

		const probe = Bun.spawnSync(
			["kubectl", "--context", "boilerhouse-test", "cluster-info"],
			{ stdout: "ignore", stderr: "ignore" },
		);
		return probe.exitCode === 0;
	} catch {
		return false;
	}
}

function getApiUrl(): string {
	// Use kubeconfig to get the API URL — minikube ip is not routable
	// from the host with the docker driver on macOS.
	return Bun.spawnSync(
		["kubectl", "--context", "boilerhouse-test", "config", "view", "--minify", "-o", "jsonpath={.clusters[0].cluster.server}"],
		{ stdout: "pipe" },
	).stdout.toString().trim();
}

function getServiceAccountToken(): string {
	return Bun.spawnSync(
		["kubectl", "--context", "boilerhouse-test", "-n", "boilerhouse", "create", "token", "default"],
		{ stdout: "pipe" },
	).stdout.toString().trim();
}

function createRuntime(opts?: { minikubeProfile?: string }): KubernetesRuntime {
	const apiUrl = getApiUrl();
	const token = getServiceAccountToken();
	return new KubernetesRuntime({
		auth: "external",
		apiUrl,
		token,
		namespace: "boilerhouse",
		context: "boilerhouse-test",
		minikubeProfile: opts?.minikubeProfile,
	});
}

function testWorkload(overrides: Record<string, unknown> = {}): Workload {
	return {
		workload: { name: "int-test", version: "1.0.0" },
		image: { ref: "docker.io/library/alpine:3.21" },
		resources: { vcpus: 1, memory_mb: 128 },
		network: { access: "none" },
		entrypoint: { cmd: "/bin/sh", args: ["-c", "while true; do sleep 1; done"] },
		...overrides,
	} as Workload;
}

/**
 * Minimal Envoy bootstrap config for integration testing.
 * Listens on 18080 (proxy) and 18081 (admin), returns 403 for all requests.
 */
function minimalEnvoyConfig(): string {
	return `
admin:
  address:
    socket_address: { address: 127.0.0.1, port_value: 18081 }
static_resources:
  listeners:
    - name: proxy
      address:
        socket_address: { address: 127.0.0.1, port_value: 18080 }
      filter_chains:
        - filters:
            - name: envoy.filters.network.http_connection_manager
              typed_config:
                "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
                stat_prefix: proxy
                http_filters:
                  - name: envoy.filters.http.router
                    typed_config:
                      "@type": type.googleapis.com/envoy.extensions.filters.http.router.v3.Router
                route_config:
                  virtual_hosts:
                    - name: deny_all
                      domains: ["*"]
                      routes:
                        - match: { prefix: "/" }
                          direct_response: { status: 403, body: { inline_string: "blocked" } }
`.trim();
}

const available = k8sAvailable();

describe.skipIf(!available)("KubernetesRuntime integration", () => {
	const handles: Array<{ instanceId: InstanceId; running: boolean }> = [];
	let runtime: KubernetesRuntime;

	// Lazy init to avoid calling minikube ip when tests are skipped.
	// When opts are provided, creates a fresh runtime (needed for minikubeProfile).
	function getRuntime(opts?: { minikubeProfile?: string }): KubernetesRuntime {
		if (opts) return createRuntime(opts);
		if (!runtime) {
			runtime = createRuntime();
		}
		return runtime;
	}

	afterAll(async () => {
		const rt = getRuntime();
		for (const h of handles) {
			await rt.destroy(h).catch(() => {});
		}
	});

	function instanceId(): InstanceId {
		return `int-test-${crypto.randomUUID()}` as InstanceId;
	}

	test("available() returns true", async () => {
		expect(await getRuntime().available()).toBe(true);
	});

	test("create + start + destroy lifecycle", async () => {
		const rt = getRuntime();
		const id = instanceId();

		const handle = await rt.create(testWorkload(), id);
		handles.push(handle);
		expect(handle.instanceId).toBe(id);
		expect(handle.running).toBe(false);

		await rt.start(handle);
		expect(handle.running).toBe(true);

		await rt.destroy(handle);
		expect(handle.running).toBe(false);
	}, 120_000);

	test("exec runs command in pod", async () => {
		const rt = getRuntime();
		const id = instanceId();

		const handle = await rt.create(testWorkload({ workload: { name: "int-test-exec", version: "1.0.0" } }), id);
		handles.push(handle);
		await rt.start(handle);

		const result = await rt.exec(handle, ["echo", "hello-k8s"]);
		expect(result.stdout).toContain("hello-k8s");

		await rt.destroy(handle);
	}, 120_000);

	test("logs returns container output", async () => {
		const rt = getRuntime();
		const id = instanceId();

		const handle = await rt.create(testWorkload({
			workload: { name: "int-test-logs", version: "1.0.0" },
			entrypoint: { cmd: "/bin/sh", args: ["-c", "echo 'test-log-output' && sleep 3600"] },
		}), id);
		handles.push(handle);
		await rt.start(handle);

		// Give it a moment to produce logs
		await new Promise((r) => setTimeout(r, 2000));

		const logs = await rt.logs!(handle);
		expect(logs).toContain("test-log-output");

		await rt.destroy(handle);
	}, 120_000);

	test("getEndpoint returns pod IP for networked pod", async () => {
		const rt = getRuntime();
		const id = instanceId();

		const handle = await rt.create(testWorkload({
			workload: { name: "int-test-endpoint", version: "1.0.0" },
			image: { ref: "docker.io/library/python:3-alpine" },
			resources: { vcpus: 1, memory_mb: 256 },
			network: { access: "outbound", expose: [{ guest: 8080, host_range: [0, 0] }] },
			entrypoint: { cmd: "python3", args: ["-m", "http.server", "8080"] },
		}), id);
		handles.push(handle);
		await rt.start(handle);

		const endpoint = await rt.getEndpoint(handle);
		expect(endpoint.host).toBeTruthy();
		expect(endpoint.ports.length).toBeGreaterThanOrEqual(1);
		// Port is the local forwarded port, not the container port
		expect(endpoint.ports[0]).toBeGreaterThan(0);

		await rt.destroy(handle);
	}, 120_000);

	test("list returns managed pods", async () => {
		const rt = getRuntime();
		const id = instanceId();

		const handle = await rt.create(testWorkload({ workload: { name: "int-test-list", version: "1.0.0" } }), id);
		handles.push(handle);
		await rt.start(handle);

		const ids = await rt.list();
		expect(ids).toContain(id);

		await rt.destroy(handle);
	}, 120_000);

	test("create fails with bad image", async () => {
		const rt = getRuntime();
		const id = instanceId();

		const handle = await rt.create(testWorkload({
			workload: { name: "int-test-bad", version: "1.0.0" },
			image: { ref: "docker.io/library/nonexistent-image:99.99.99" },
			entrypoint: { cmd: "/bin/sh", args: ["-c", "true"] },
		}), id);
		handles.push(handle);

		await expect(rt.start(handle)).rejects.toThrow();

		await rt.destroy(handle);
	}, 120_000);

	test("envoy sidecar proxy: pod has proxy container and HTTP_PROXY env", async () => {
		const rt = getRuntime({ minikubeProfile: "boilerhouse-test" });
		const id = instanceId();

		const proxyConfig = minimalEnvoyConfig();

		const handle = await rt.create(testWorkload({
			workload: { name: "int-test-proxy", version: "1.0.0" },
			network: { access: "restricted" },
			entrypoint: { cmd: "/bin/sh", args: ["-c", "while true; do sleep 1; done"] },
		}), id, { proxyConfig });
		handles.push(handle);

		await rt.start(handle);

		// Verify HTTP_PROXY is set in the main container
		const envResult = await rt.exec(handle, ["printenv", "HTTP_PROXY"]);
		expect(envResult.stdout.trim()).toBe("http://localhost:18080");

		// Verify envoy sidecar is running and reachable from the main container.
		// Unset HTTP_PROXY so wget connects directly (not via the proxy),
		// and use 127.0.0.1 explicitly (envoy binds IPv4 only).
		const probeResult = await rt.exec(handle, [
			"sh", "-c", "unset HTTP_PROXY http_proxy; wget -q -O /dev/null --timeout=5 http://127.0.0.1:18081/server_info",
		]);
		expect(probeResult.exitCode).toBe(0);

		await rt.destroy(handle);
	}, 120_000);

	test("envoy sidecar proxy: cleanup removes ConfigMap and NetworkPolicy", async () => {
		const rt = getRuntime({ minikubeProfile: "boilerhouse-test" });
		const id = instanceId();

		const proxyConfig = minimalEnvoyConfig();

		const handle = await rt.create(testWorkload({
			workload: { name: "int-test-proxy-cleanup", version: "1.0.0" },
			network: { access: "restricted" },
		}), id, { proxyConfig });
		handles.push(handle);

		await rt.start(handle);
		await rt.destroy(handle);

		// Verify ConfigMap is cleaned up
		const cmResult = Bun.spawnSync([
			"kubectl", "--context", "boilerhouse-test",
			"-n", "boilerhouse",
			"get", "configmap", `${id}-proxy`,
			"-o", "name",
		], { stdout: "pipe", stderr: "pipe" });
		expect(cmResult.exitCode).not.toBe(0); // Should be 404 / not found

		// Verify NetworkPolicy is cleaned up
		const npResult = Bun.spawnSync([
			"kubectl", "--context", "boilerhouse-test",
			"-n", "boilerhouse",
			"get", "networkpolicy", `${id}-restrict`,
			"-o", "name",
		], { stdout: "pipe", stderr: "pipe" });
		expect(npResult.exitCode).not.toBe(0); // Should be 404 / not found
	}, 120_000);
});
