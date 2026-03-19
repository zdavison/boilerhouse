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

function getMinikubeIp(): string {
	return Bun.spawnSync(
		["minikube", "ip", "-p", "boilerhouse-test"],
		{ stdout: "pipe" },
	).stdout.toString().trim();
}

function getServiceAccountToken(): string {
	return Bun.spawnSync(
		["kubectl", "--context", "boilerhouse-test", "-n", "boilerhouse", "create", "token", "default"],
		{ stdout: "pipe" },
	).stdout.toString().trim();
}

function createRuntime(): KubernetesRuntime {
	const ip = getMinikubeIp();
	const token = getServiceAccountToken();
	return new KubernetesRuntime({
		auth: "external",
		apiUrl: `https://${ip}:8443`,
		token,
		namespace: "boilerhouse",
		context: "boilerhouse-test",
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

const available = k8sAvailable();

describe.skipIf(!available)("KubernetesRuntime integration", () => {
	const handles: Array<{ instanceId: InstanceId; running: boolean }> = [];
	let runtime: KubernetesRuntime;

	// Lazy init to avoid calling minikube ip when tests are skipped
	function getRuntime(): KubernetesRuntime {
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
});
