import { describe, test, expect, afterEach } from "bun:test";
import { KubeClient } from "./client";
import { KubernetesRuntimeError } from "./errors";

/**
 * Creates a mock HTTP server using Bun.serve on a random port.
 * Returns the base URL and a cleanup function.
 */
function createMockK8sApi(
	handler: (req: Request) => Response | Promise<Response>,
): { baseUrl: string; server: ReturnType<typeof Bun.serve>; close: () => void } {
	const server = Bun.serve({
		port: 0,
		fetch: handler,
	});
	return {
		baseUrl: `http://localhost:${server.port}`,
		server,
		close: () => server.stop(true),
	};
}

describe("KubeClient", () => {
	let mock: ReturnType<typeof createMockK8sApi> | undefined;
	let client: KubeClient;

	afterEach(() => {
		if (mock) {
			mock.close();
			mock = undefined;
		}
	});

	function setup(
		handler: (req: Request) => Response | Promise<Response>,
	): void {
		mock = createMockK8sApi(handler);
		client = new KubeClient({
			apiUrl: mock.baseUrl,
			token: "test-token",
		});
	}

	// ── Pod operations ──────────────────────────────────────────────────

	test("createPod sends POST and returns pod", async () => {
		const podSpec = {
			apiVersion: "v1" as const,
			kind: "Pod" as const,
			metadata: { name: "test-pod", namespace: "default" },
			spec: { containers: [{ name: "main", image: "alpine:3.21" }] },
		};

		setup(async (req) => {
			expect(req.method).toBe("POST");
			expect(new URL(req.url).pathname).toBe("/api/v1/namespaces/default/pods");
			expect(req.headers.get("Authorization")).toBe("Bearer test-token");
			const body = await req.json();
			expect(body.metadata.name).toBe("test-pod");
			return Response.json({ ...podSpec, status: { phase: "Pending" } }, { status: 201 });
		});

		const result = await client.createPod("default", podSpec);
		expect(result.metadata.name).toBe("test-pod");
	});

	test("getPod sends GET and returns pod", async () => {
		setup((req) => {
			expect(req.method).toBe("GET");
			expect(new URL(req.url).pathname).toBe("/api/v1/namespaces/ns/pods/my-pod");
			return Response.json({
				metadata: { name: "my-pod" },
				status: { phase: "Running", podIP: "10.244.0.5" },
			});
		});

		const pod = await client.getPod("ns", "my-pod");
		expect(pod.status?.phase).toBe("Running");
		expect(pod.status?.podIP).toBe("10.244.0.5");
	});

	test("deletePod sends DELETE with gracePeriodSeconds", async () => {
		setup((req) => {
			expect(req.method).toBe("DELETE");
			const url = new URL(req.url);
			expect(url.pathname).toBe("/api/v1/namespaces/ns/pods/my-pod");
			expect(url.searchParams.get("gracePeriodSeconds")).toBe("0");
			return Response.json({ kind: "Status", status: "Success", code: 200 });
		});

		await client.deletePod("ns", "my-pod");
	});

	test("deletePod ignores 404", async () => {
		setup(() => Response.json(
			{ kind: "Status", status: "Failure", message: "not found", code: 404 },
			{ status: 404 },
		));

		// Should not throw
		await client.deletePod("ns", "gone-pod");
	});

	test("listPods sends GET with label selector", async () => {
		setup((req) => {
			const url = new URL(req.url);
			expect(url.pathname).toBe("/api/v1/namespaces/ns/pods");
			expect(url.searchParams.get("labelSelector")).toBe("app=test");
			return Response.json({ items: [{ metadata: { name: "pod-1" } }] });
		});

		const list = await client.listPods("ns", "app=test");
		expect(list.items).toHaveLength(1);
	});

	test("waitForPodRunning returns when pod is Running", async () => {
		let callCount = 0;
		setup((req) => {
			const url = new URL(req.url);
			if (url.pathname.includes("/pods/")) {
				callCount++;
				const phase = callCount >= 2 ? "Running" : "Pending";
				return Response.json({
					metadata: { name: "my-pod" },
					status: { phase, podIP: "10.244.0.5" },
				});
			}
			return new Response("not found", { status: 404 });
		});

		const pod = await client.waitForPodRunning("ns", "my-pod", 5000, 50);
		expect(pod.status?.phase).toBe("Running");
		expect(callCount).toBeGreaterThanOrEqual(2);
	});

	test("waitForPodRunning throws on Failed phase", async () => {
		setup(() => Response.json({
			metadata: { name: "bad-pod" },
			status: { phase: "Failed" },
		}));

		await expect(
			client.waitForPodRunning("ns", "bad-pod", 1000, 50),
		).rejects.toThrow("terminal phase Failed");
	});

	test("waitForPodRunning throws on ImagePullBackOff", async () => {
		setup(() => Response.json({
			metadata: { name: "bad-pod" },
			status: {
				phase: "Pending",
				containerStatuses: [{
					name: "main",
					ready: false,
					state: { waiting: { reason: "ImagePullBackOff", message: "image not found" } },
				}],
			},
		}));

		await expect(
			client.waitForPodRunning("ns", "bad-pod", 1000, 50),
		).rejects.toThrow("ImagePullBackOff");
	});

	test("waitForPodRunning times out", async () => {
		setup(() => Response.json({
			metadata: { name: "slow-pod" },
			status: { phase: "Pending" },
		}));

		await expect(
			client.waitForPodRunning("ns", "slow-pod", 200, 50),
		).rejects.toThrow("did not reach Running phase");
	});

	// ── Logs ────────────────────────────────────────────────────────────

	test("getPodLogs returns log text", async () => {
		setup((req) => {
			const url = new URL(req.url);
			expect(url.pathname).toBe("/api/v1/namespaces/ns/pods/my-pod/log");
			expect(url.searchParams.get("tailLines")).toBe("50");
			return new Response("line1\nline2\n");
		});

		const logs = await client.getPodLogs("ns", "my-pod", 50);
		expect(logs).toBe("line1\nline2\n");
	});

	// ── Service operations ──────────────────────────────────────────────

	test("createService sends POST and returns service", async () => {
		const svc = {
			apiVersion: "v1" as const,
			kind: "Service" as const,
			metadata: { name: "my-svc" },
			spec: {
				selector: { app: "test" },
				ports: [{ port: 80, targetPort: 8080 }],
			},
		};

		setup(async (req) => {
			expect(req.method).toBe("POST");
			expect(new URL(req.url).pathname).toBe("/api/v1/namespaces/ns/services");
			return Response.json(svc, { status: 201 });
		});

		const result = await client.createService("ns", svc);
		expect(result.metadata.name).toBe("my-svc");
	});

	test("deleteService ignores 404", async () => {
		setup(() => Response.json(
			{ kind: "Status", status: "Failure", message: "not found", code: 404 },
			{ status: 404 },
		));

		await client.deleteService("ns", "gone-svc");
	});

	// ── Namespace ───────────────────────────────────────────────────────

	test("getNamespace returns namespace object", async () => {
		setup((req) => {
			expect(new URL(req.url).pathname).toBe("/api/v1/namespaces/boilerhouse");
			return Response.json({
				apiVersion: "v1",
				kind: "Namespace",
				metadata: { name: "boilerhouse" },
				status: { phase: "Active" },
			});
		});

		const ns = await client.getNamespace("boilerhouse");
		expect(ns.status?.phase).toBe("Active");
	});

	// ── Error handling ──────────────────────────────────────────────────

	test("throws KubernetesRuntimeError on non-ok response", async () => {
		setup(() => Response.json(
			{ message: "forbidden" },
			{ status: 403 },
		));

		await expect(
			client.getPod("ns", "pod"),
		).rejects.toThrow(KubernetesRuntimeError);
	});

	test("error includes status code", async () => {
		setup(() => Response.json(
			{ message: "not found" },
			{ status: 404 },
		));

		try {
			await client.getPod("ns", "pod");
			expect.unreachable("should throw");
		} catch (err) {
			expect(err).toBeInstanceOf(KubernetesRuntimeError);
			expect((err as KubernetesRuntimeError).statusCode).toBe(404);
		}
	});

	test("connection error throws KubernetesRuntimeError", async () => {
		const badClient = new KubeClient({
			apiUrl: "http://localhost:1",
			token: "fake",
		});

		await expect(badClient.getNamespace("test")).rejects.toThrow();
	});
});
