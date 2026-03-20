import { describe, test, expect, afterEach } from "bun:test";
import type { Workload, InstanceId } from "@boilerhouse/core";
import { KubernetesRuntime } from "./runtime";
import { MANAGED_LABEL } from "./translator";

const INSTANCE_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890" as InstanceId;

function makeWorkload(overrides: Partial<Workload> = {}): Workload {
	return {
		workload: { name: "test-workload", version: "1.0.0" },
		image: { ref: "docker.io/library/alpine:3.21" },
		resources: { vcpus: 1, memory_mb: 256 },
		network: { access: "none" },
		...overrides,
	} as Workload;
}

/**
 * Creates a mock K8s API server that tracks state and returns realistic responses.
 */
function createMockK8sServer(): {
	server: ReturnType<typeof Bun.serve>;
	baseUrl: string;
	close: () => void;
	pods: Map<string, { spec: unknown; status: { phase: string; podIP: string } }>;
	services: Map<string, unknown>;
} {
	const pods = new Map<string, { spec: unknown; status: { phase: string; podIP: string } }>();
	const services = new Map<string, unknown>();

	const server = Bun.serve({
		port: 0,
		fetch: async (req) => {
			const url = new URL(req.url);
			const path = url.pathname;

			// Namespace check
			if (path === "/api/v1/namespaces/boilerhouse") {
				return Response.json({
					metadata: { name: "boilerhouse" },
					status: { phase: "Active" },
				});
			}

			// Create pod
			if (path === "/api/v1/namespaces/boilerhouse/pods" && req.method === "POST") {
				const body = await req.json() as { metadata: { name: string; labels?: Record<string, string> }; spec: unknown };
				const name = body.metadata.name;
				pods.set(name, {
					spec: body.spec,
					status: { phase: "Running", podIP: "10.244.0.10" },
				});
				return Response.json({
					metadata: { name, namespace: "boilerhouse", labels: body.metadata.labels },
					spec: body.spec,
					status: { phase: "Pending" },
				}, { status: 201 });
			}

			// Get pod
			const podMatch = path.match(/^\/api\/v1\/namespaces\/boilerhouse\/pods\/([^/]+)$/);
			if (podMatch && req.method === "GET") {
				const name = podMatch[1]!;
				const pod = pods.get(name);
				if (!pod) {
					return Response.json(
						{ kind: "Status", status: "Failure", message: "not found", code: 404 },
						{ status: 404 },
					);
				}
				return Response.json({
					metadata: { name, namespace: "boilerhouse" },
					spec: pod.spec,
					status: pod.status,
				});
			}

			// Delete pod
			if (podMatch && req.method === "DELETE") {
				const name = podMatch[1]!;
				pods.delete(name);
				return Response.json({ kind: "Status", status: "Success", code: 200 });
			}

			// List pods
			if (path === "/api/v1/namespaces/boilerhouse/pods" && req.method === "GET") {
				const items = Array.from(pods.entries()).map(([name, pod]) => ({
					metadata: {
						name,
						namespace: "boilerhouse",
						labels: { [MANAGED_LABEL]: "true" },
					},
					spec: pod.spec,
					status: pod.status,
				}));
				return Response.json({ apiVersion: "v1", kind: "PodList", items });
			}

			// Pod logs
			const logMatch = path.match(/^\/api\/v1\/namespaces\/boilerhouse\/pods\/([^/]+)\/log$/);
			if (logMatch) {
				const name = logMatch[1]!;
				if (!pods.has(name)) {
					return Response.json(
						{ kind: "Status", status: "Failure", message: "not found", code: 404 },
						{ status: 404 },
					);
				}
				return new Response("fake log line 1\nfake log line 2\n");
			}

			// Create service
			if (path === "/api/v1/namespaces/boilerhouse/services" && req.method === "POST") {
				const body = await req.json() as { metadata: { name: string } };
				services.set(body.metadata.name, body);
				return Response.json(body, { status: 201 });
			}

			// Delete service
			const svcMatch = path.match(/^\/api\/v1\/namespaces\/boilerhouse\/services\/([^/]+)$/);
			if (svcMatch && req.method === "DELETE") {
				services.delete(svcMatch[1]!);
				return Response.json({ kind: "Status", status: "Success", code: 200 });
			}

			return new Response("not found", { status: 404 });
		},
	});

	return {
		server,
		baseUrl: `http://localhost:${server.port}`,
		close: () => server.stop(true),
		pods,
		services,
	};
}

describe("KubernetesRuntime", () => {
	let mockServer: ReturnType<typeof createMockK8sServer>;
	let runtime: KubernetesRuntime;

	function setup(): void {
		mockServer = createMockK8sServer();
		runtime = new KubernetesRuntime({
			auth: "external",
			apiUrl: mockServer.baseUrl,
			token: "test-token",
			namespace: "boilerhouse",
		});
	}

	afterEach(() => {
		if (mockServer) {
			mockServer.close();
		}
	});

	test("capabilities.goldenSnapshots is false", () => {
		setup();
		expect(runtime.capabilities.goldenSnapshots).toBe(false);
	});

	test("available() returns true when namespace is Active", async () => {
		setup();
		expect(await runtime.available()).toBe(true);
	});

	test("available() returns false on connection error", async () => {
		runtime = new KubernetesRuntime({
			auth: "external",
			apiUrl: "http://localhost:1",
			token: "fake",
			namespace: "boilerhouse",
		});
		expect(await runtime.available()).toBe(false);
	});

	test("create() creates a pod and tracks it", async () => {
		setup();
		const workload = makeWorkload();
		const handle = await runtime.create(workload, INSTANCE_ID);

		expect(handle.instanceId).toBe(INSTANCE_ID);
		expect(handle.running).toBe(false);
		expect(mockServer.pods.has(INSTANCE_ID)).toBe(true);
	});

	test("create() creates a Service when ports are exposed", async () => {
		setup();
		const workload = makeWorkload({
			network: {
				access: "outbound",
				expose: [{ guest: 8080, host_range: [0, 0] }],
			},
		});
		await runtime.create(workload, INSTANCE_ID);

		expect(mockServer.services.has(`svc-${INSTANCE_ID}`)).toBe(true);
	});

	test("create() does not create a Service when no ports exposed", async () => {
		setup();
		const workload = makeWorkload({ network: { access: "none" } });
		await runtime.create(workload, INSTANCE_ID);

		expect(mockServer.services.has(`svc-${INSTANCE_ID}`)).toBe(false);
	});

	test("start() waits for pod to be Running", async () => {
		setup();
		const workload = makeWorkload();
		const handle = await runtime.create(workload, INSTANCE_ID);

		await runtime.start(handle);
		expect(handle.running).toBe(true);
	});

	test("destroy() removes pod and service", async () => {
		setup();
		const workload = makeWorkload({
			network: {
				access: "outbound",
				expose: [{ guest: 8080, host_range: [0, 0] }],
			},
		});
		const handle = await runtime.create(workload, INSTANCE_ID);
		await runtime.start(handle);
		await runtime.destroy(handle);

		expect(mockServer.pods.has(INSTANCE_ID)).toBe(false);
		expect(mockServer.services.has(`svc-${INSTANCE_ID}`)).toBe(false);
		expect(handle.running).toBe(false);
	});

	test("destroy() is idempotent", async () => {
		setup();
		const workload = makeWorkload();
		const handle = await runtime.create(workload, INSTANCE_ID);
		await runtime.destroy(handle);
		// Should not throw
		await runtime.destroy(handle);
	});

	test("getEndpoint() returns pod IP and container ports", async () => {
		setup();
		const workload = makeWorkload({
			network: {
				access: "outbound",
				expose: [{ guest: 8080, host_range: [0, 0] }],
			},
		});
		const handle = await runtime.create(workload, INSTANCE_ID);
		await runtime.start(handle);

		const endpoint = await runtime.getEndpoint(handle);
		expect(endpoint.host).toBe("10.244.0.10");
		expect(endpoint.ports).toContain(8080);
	});

	test("list() returns tracked pod instance IDs", async () => {
		setup();
		const workload = makeWorkload();
		await runtime.create(workload, INSTANCE_ID);

		const ids = await runtime.list();
		expect(ids).toContain(INSTANCE_ID);
	});

	test("logs() returns pod logs", async () => {
		setup();
		const workload = makeWorkload();
		const handle = await runtime.create(workload, INSTANCE_ID);
		await runtime.start(handle);

		const logs = await runtime.logs!(handle);
		expect(logs).toContain("fake log line");
	});

	test("logs() returns null on error", async () => {
		setup();
		const handle = { instanceId: "nonexistent" as InstanceId, running: true };
		const logs = await runtime.logs!(handle);
		expect(logs).toBeNull();
	});
});
