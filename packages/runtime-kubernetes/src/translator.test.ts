import { describe, test, expect } from "bun:test";
import type { Workload, InstanceId } from "@boilerhouse/core";
import { workloadToPod, MANAGED_LABEL, INSTANCE_ID_LABEL, WORKLOAD_NAME_LABEL, ENVOY_IMAGE, ENVOY_PROXY_PORT } from "./translator";

function makeWorkload(overrides: Record<string, unknown> = {}): Workload {
	return {
		workload: { name: "test-workload", version: "1.0.0" },
		image: { ref: "docker.io/library/alpine:3.21" },
		resources: { vcpus: 1, memory_mb: 256, disk_gb: 2 },
		network: { access: "none" },
		...overrides,
	} as Workload;
}

const INSTANCE_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890" as InstanceId;
const NAMESPACE = "boilerhouse";

describe("workloadToPod", () => {
	test("creates pod with correct metadata and labels", () => {
		const workload = makeWorkload();
		const { pod } = workloadToPod(workload, INSTANCE_ID, NAMESPACE);

		expect(pod.apiVersion).toBe("v1");
		expect(pod.kind).toBe("Pod");
		expect(pod.metadata.name).toBe(INSTANCE_ID);
		expect(pod.metadata.namespace).toBe(NAMESPACE);
		expect(pod.metadata.labels).toEqual({
			[MANAGED_LABEL]: "true",
			[INSTANCE_ID_LABEL]: INSTANCE_ID,
			[WORKLOAD_NAME_LABEL]: "test-workload",
		});
	});

	test("maps image.ref to container image", () => {
		const workload = makeWorkload({ image: { ref: "python:3-alpine" } });
		const { pod } = workloadToPod(workload, INSTANCE_ID, NAMESPACE);

		expect(pod.spec.containers[0]!.image).toBe("python:3-alpine");
	});

	test("maps resources to limits and requests", () => {
		const workload = makeWorkload({
			resources: { vcpus: 2, memory_mb: 1024 },
		});
		const { pod } = workloadToPod(workload, INSTANCE_ID, NAMESPACE);
		const resources = pod.spec.containers[0]!.resources!;

		expect(resources.limits!.cpu).toBe("2000m");
		expect(resources.limits!.memory).toBe("1024Mi");
		expect(resources.requests).toBeDefined();
	});

	test("maps entrypoint cmd to command", () => {
		const workload = makeWorkload({
			entrypoint: { cmd: "/usr/bin/python3" },
		});
		const { pod } = workloadToPod(workload, INSTANCE_ID, NAMESPACE);

		expect(pod.spec.containers[0]!.command).toEqual(["/usr/bin/python3"]);
	});

	test("maps entrypoint args to args", () => {
		const workload = makeWorkload({
			entrypoint: { cmd: "python3", args: ["-m", "http.server", "8080"] },
		});
		const { pod } = workloadToPod(workload, INSTANCE_ID, NAMESPACE);

		expect(pod.spec.containers[0]!.command).toEqual(["python3"]);
		expect(pod.spec.containers[0]!.args).toEqual(["-m", "http.server", "8080"]);
	});

	test("maps entrypoint env to container env", () => {
		const workload = makeWorkload({
			entrypoint: { cmd: "node", env: { FOO: "bar", BAZ: "qux" } },
		});
		const { pod } = workloadToPod(workload, INSTANCE_ID, NAMESPACE);

		expect(pod.spec.containers[0]!.env).toEqual([
			{ name: "FOO", value: "bar" },
			{ name: "BAZ", value: "qux" },
		]);
	});

	test("maps entrypoint workdir to workingDir", () => {
		const workload = makeWorkload({
			entrypoint: { cmd: "node", workdir: "/app" },
		});
		const { pod } = workloadToPod(workload, INSTANCE_ID, NAMESPACE);

		expect(pod.spec.containers[0]!.workingDir).toBe("/app");
	});

	test("maps expose ports to container ports", () => {
		const workload = makeWorkload({
			network: {
				access: "unrestricted",
				expose: [
					{ guest: 8080, host_range: [0, 0] },
					{ guest: 9090, host_range: [0, 0] },
				],
			},
		});
		const { pod } = workloadToPod(workload, INSTANCE_ID, NAMESPACE);

		expect(pod.spec.containers[0]!.ports).toEqual([
			{ containerPort: 8080, protocol: "TCP" },
			{ containerPort: 9090, protocol: "TCP" },
		]);
	});

	test("creates Service when ports are exposed", () => {
		const workload = makeWorkload({
			network: {
				access: "unrestricted",
				expose: [{ guest: 8080, host_range: [0, 0] }],
			},
		});
		const { service } = workloadToPod(workload, INSTANCE_ID, NAMESPACE);

		expect(service).toBeDefined();
		expect(service!.apiVersion).toBe("v1");
		expect(service!.kind).toBe("Service");
		expect(service!.metadata.name).toBe(`svc-${INSTANCE_ID}`);
		expect(service!.spec.selector).toEqual({
			[INSTANCE_ID_LABEL]: INSTANCE_ID,
		});
		expect(service!.spec.ports).toEqual([
			{ port: 8080, targetPort: 8080, protocol: "TCP" },
		]);
	});

	test("Service ports have names when multiple ports exposed", () => {
		const workload = makeWorkload({
			network: {
				access: "unrestricted",
				expose: [
					{ guest: 8080, host_range: [0, 0] },
					{ guest: 8081, host_range: [0, 0] },
				],
			},
		});
		const { service } = workloadToPod(workload, INSTANCE_ID, NAMESPACE);

		expect(service!.spec.ports[0]!.name).toBe("port-0");
		expect(service!.spec.ports[1]!.name).toBe("port-1");
	});

	test("no Service when no ports exposed", () => {
		const workload = makeWorkload({
			network: { access: "none" },
		});
		const { service } = workloadToPod(workload, INSTANCE_ID, NAMESPACE);

		expect(service).toBeUndefined();
	});

	test("maps HTTP health check to readinessProbe", () => {
		const workload = makeWorkload({
			network: {
				access: "unrestricted",
				expose: [{ guest: 8080, host_range: [0, 0] }],
			},
			health: {
				interval_seconds: 5,
				unhealthy_threshold: 3,
				http_get: { path: "/health", port: 8080 },
			},
		});
		const { pod } = workloadToPod(workload, INSTANCE_ID, NAMESPACE);
		const probe = pod.spec.containers[0]!.readinessProbe!;

		expect(probe.httpGet).toEqual({ path: "/health", port: 8080 });
		expect(probe.periodSeconds).toBe(5);
		expect(probe.failureThreshold).toBe(3);
	});

	test("maps exec health check to readinessProbe", () => {
		const workload = makeWorkload({
			health: {
				interval_seconds: 10,
				unhealthy_threshold: 5,
				exec: { command: ["cat", "/tmp/healthy"] },
			},
		});
		const { pod } = workloadToPod(workload, INSTANCE_ID, NAMESPACE);
		const probe = pod.spec.containers[0]!.readinessProbe!;

		expect(probe.exec).toEqual({ command: ["cat", "/tmp/healthy"] });
	});

	test("maps overlay_dirs to emptyDir volumes", () => {
		const workload = makeWorkload({
			filesystem: {
				overlay_dirs: ["/home/node/.openclaw", "/var/data"],
			},
		});
		const { pod } = workloadToPod(workload, INSTANCE_ID, NAMESPACE);

		expect(pod.spec.volumes).toEqual([
			{ name: "overlay-0", emptyDir: { sizeLimit: "256Mi" } },
			{ name: "overlay-1", emptyDir: { sizeLimit: "256Mi" } },
		]);

		expect(pod.spec.containers[0]!.volumeMounts).toEqual([
			{ name: "overlay-0", mountPath: "/home/node/.openclaw" },
			{ name: "overlay-1", mountPath: "/var/data" },
		]);
	});

	test("restartPolicy is Never", () => {
		const workload = makeWorkload();
		const { pod } = workloadToPod(workload, INSTANCE_ID, NAMESPACE);

		expect(pod.spec.restartPolicy).toBe("Never");
	});

	// ── Security hardening ─────────────────────────────────────────────

	test("main container drops ALL capabilities", () => {
		const workload = makeWorkload();
		const { pod } = workloadToPod(workload, INSTANCE_ID, NAMESPACE);
		const sc = pod.spec.containers[0]!.securityContext!;

		expect(sc.capabilities?.drop).toEqual(["ALL"]);
	});

	test("main container has runAsNonRoot and allowPrivilegeEscalation disabled", () => {
		const workload = makeWorkload();
		const { pod } = workloadToPod(workload, INSTANCE_ID, NAMESPACE);
		const sc = pod.spec.containers[0]!.securityContext!;

		expect(sc.runAsNonRoot).toBe(true);
		expect(sc.allowPrivilegeEscalation).toBe(false);
	});

	test("pod spec disables service account token automount", () => {
		const workload = makeWorkload();
		const { pod } = workloadToPod(workload, INSTANCE_ID, NAMESPACE);

		expect(pod.spec.automountServiceAccountToken).toBe(false);
	});

	test("pod spec blocks host namespace sharing", () => {
		const workload = makeWorkload();
		const { pod } = workloadToPod(workload, INSTANCE_ID, NAMESPACE);

		expect(pod.spec.hostNetwork).toBe(false);
		expect(pod.spec.hostPID).toBe(false);
		expect(pod.spec.hostIPC).toBe(false);
	});

	test("pod spec has RuntimeDefault seccomp profile and runAsNonRoot", () => {
		const workload = makeWorkload();
		const { pod } = workloadToPod(workload, INSTANCE_ID, NAMESPACE);

		expect(pod.spec.securityContext?.runAsNonRoot).toBe(true);
		expect(pod.spec.securityContext?.seccompProfile?.type).toBe("RuntimeDefault");
	});

	test("sidecar container has hardened securityContext when proxyConfig provided", () => {
		const workload = makeWorkload({
			network: { access: "restricted" },
		});
		const { pod } = workloadToPod(workload, INSTANCE_ID, NAMESPACE, undefined, "config: {}");
		const sc = pod.spec.containers[1]!.securityContext!;

		expect(sc.capabilities?.drop).toEqual(["ALL"]);
		expect(sc.allowPrivilegeEscalation).toBe(false);
		expect(sc.runAsNonRoot).toBe(true);
		expect(sc.readOnlyRootFilesystem).toBe(true);
	});

	test("no volumes when no overlay_dirs", () => {
		const workload = makeWorkload();
		const { pod } = workloadToPod(workload, INSTANCE_ID, NAMESPACE);

		expect(pod.spec.volumes).toBeUndefined();
		expect(pod.spec.containers[0]!.volumeMounts).toBeUndefined();
	});

	test("health check uses first exposed port as default", () => {
		const workload = makeWorkload({
			network: {
				access: "unrestricted",
				expose: [{ guest: 3000, host_range: [0, 0] }],
			},
			health: {
				interval_seconds: 5,
				unhealthy_threshold: 3,
				http_get: { path: "/" },
			},
		});
		const { pod } = workloadToPod(workload, INSTANCE_ID, NAMESPACE);
		const probe = pod.spec.containers[0]!.readinessProbe!;

		expect(probe.httpGet!.port).toBe(3000);
	});

	test("health check falls back to 8080 when no ports exposed", () => {
		const workload = makeWorkload({
			health: {
				interval_seconds: 5,
				unhealthy_threshold: 3,
				http_get: { path: "/" },
			},
		});
		const { pod } = workloadToPod(workload, INSTANCE_ID, NAMESPACE);
		const probe = pod.spec.containers[0]!.readinessProbe!;

		expect(probe.httpGet!.port).toBe(8080);
	});

	test("check_timeout_seconds maps to timeoutSeconds", () => {
		const workload = makeWorkload({
			health: {
				interval_seconds: 5,
				unhealthy_threshold: 3,
				check_timeout_seconds: 10,
				http_get: { path: "/" },
			},
		});
		const { pod } = workloadToPod(workload, INSTANCE_ID, NAMESPACE);
		const probe = pod.spec.containers[0]!.readinessProbe!;

		expect(probe.timeoutSeconds).toBe(10);
	});

	test("throws when workload has no image ref and no override", () => {
		const workload = makeWorkload({ image: { dockerfile: "some/Dockerfile" } });
		expect(() => workloadToPod(workload, INSTANCE_ID, NAMESPACE)).toThrow(
			"no image ref",
		);
	});

	test("uses imageOverride when provided", () => {
		const workload = makeWorkload({ image: { dockerfile: "some/Dockerfile" } });
		const { pod } = workloadToPod(workload, INSTANCE_ID, NAMESPACE, "boilerhouse/test:1.0");
		expect(pod.spec.containers[0]!.image).toBe("boilerhouse/test:1.0");
	});

	// ── Envoy sidecar proxy ────────────────────────────────────────────

	test("adds envoy sidecar container when proxyConfig provided", () => {
		const workload = makeWorkload({
			network: { access: "restricted", expose: [{ guest: 8080, host_range: [0, 0] }] },
		});
		const proxyConfig = "static_resources: {}";
		const { pod } = workloadToPod(workload, INSTANCE_ID, NAMESPACE, undefined, proxyConfig);

		expect(pod.spec.containers).toHaveLength(2);
		const sidecar = pod.spec.containers[1]!;
		expect(sidecar.name).toBe("proxy");
		expect(sidecar.image).toBe(ENVOY_IMAGE);
		expect(sidecar.command).toEqual(["envoy", "-c", "/etc/envoy/envoy.yaml", "--log-level", "warn"]);
		expect(sidecar.ports).toEqual([{ containerPort: ENVOY_PROXY_PORT }]);
		expect(sidecar.volumeMounts).toEqual([{ name: "proxy-config", mountPath: "/etc/envoy" }]);
		expect(sidecar.resources?.limits).toEqual({ cpu: "100m", memory: "64Mi" });
	});

	test("injects HTTP_PROXY env vars on main container when proxyConfig provided", () => {
		const workload = makeWorkload({
			network: { access: "restricted" },
		});
		const { pod } = workloadToPod(workload, INSTANCE_ID, NAMESPACE, undefined, "config: {}");
		const mainEnv = pod.spec.containers[0]!.env!;

		expect(mainEnv).toContainEqual({ name: "HTTP_PROXY", value: `http://localhost:${ENVOY_PROXY_PORT}` });
		expect(mainEnv).toContainEqual({ name: "http_proxy", value: `http://localhost:${ENVOY_PROXY_PORT}` });
	});

	test("appends HTTP_PROXY to existing env vars", () => {
		const workload = makeWorkload({
			network: { access: "restricted" },
			entrypoint: { cmd: "node", env: { FOO: "bar" } },
		});
		const { pod } = workloadToPod(workload, INSTANCE_ID, NAMESPACE, undefined, "config: {}");
		const mainEnv = pod.spec.containers[0]!.env!;

		expect(mainEnv[0]).toEqual({ name: "FOO", value: "bar" });
		expect(mainEnv).toContainEqual({ name: "HTTP_PROXY", value: `http://localhost:${ENVOY_PROXY_PORT}` });
	});

	test("adds proxy-config volume from ConfigMap", () => {
		const workload = makeWorkload({
			network: { access: "restricted" },
		});
		const { pod } = workloadToPod(workload, INSTANCE_ID, NAMESPACE, undefined, "config: {}");

		expect(pod.spec.volumes).toContainEqual({
			name: "proxy-config",
			configMap: { name: `${INSTANCE_ID}-proxy` },
		});
	});

	test("creates NetworkPolicy for restricted access (always, not just with proxyConfig)", () => {
		const workload = makeWorkload({
			network: { access: "restricted" },
		});
		const { networkPolicy } = workloadToPod(workload, INSTANCE_ID, NAMESPACE);

		expect(networkPolicy).toBeDefined();
		expect(networkPolicy!.apiVersion).toBe("networking.k8s.io/v1");
		expect(networkPolicy!.kind).toBe("NetworkPolicy");
		expect(networkPolicy!.metadata.name).toBe(`${INSTANCE_ID}-restrict`);
		expect(networkPolicy!.spec.podSelector.matchLabels).toEqual({
			[INSTANCE_ID_LABEL]: INSTANCE_ID,
		});
		expect(networkPolicy!.spec.policyTypes).toEqual(["Egress"]);
		// DNS egress
		expect(networkPolicy!.spec.egress![0]!.ports).toContainEqual({ protocol: "UDP", port: 53 });
		expect(networkPolicy!.spec.egress![0]!.ports).toContainEqual({ protocol: "TCP", port: 53 });
		// HTTPS egress only
		expect(networkPolicy!.spec.egress![1]!.ports).toContainEqual({ protocol: "TCP", port: 443 });
	});

	test("no sidecar when proxyConfig not provided", () => {
		const workload = makeWorkload({
			network: { access: "restricted" },
		});
		const { pod } = workloadToPod(workload, INSTANCE_ID, NAMESPACE);

		expect(pod.spec.containers).toHaveLength(1);
	});

	// ── NetworkPolicy tiers ────────────────────────────────────────────

	test("NetworkPolicy always created for access: none (deny all egress)", () => {
		const workload = makeWorkload({ network: { access: "none" } });
		const { networkPolicy } = workloadToPod(workload, INSTANCE_ID, NAMESPACE);

		expect(networkPolicy).toBeDefined();
		expect(networkPolicy!.spec.policyTypes).toEqual(["Egress"]);
		expect(networkPolicy!.spec.egress).toEqual([]);
	});

	test("NetworkPolicy for access: unrestricted allows DNS + all TCP egress", () => {
		const workload = makeWorkload({ network: { access: "unrestricted" } });
		const { networkPolicy } = workloadToPod(workload, INSTANCE_ID, NAMESPACE);

		expect(networkPolicy).toBeDefined();
		const egress = networkPolicy!.spec.egress!;
		// DNS rule
		expect(egress[0]!.ports).toContainEqual({ protocol: "UDP", port: 53 });
		expect(egress[0]!.ports).toContainEqual({ protocol: "TCP", port: 53 });
		// All-traffic rule (no port restriction)
		expect(egress[1]!.ports).toBeUndefined();
		expect(egress[1]!.to).toBeDefined();
	});

	test("NetworkPolicy blocks link-local range (covers metadata server) for unrestricted access", () => {
		const workload = makeWorkload({ network: { access: "unrestricted" } });
		const { networkPolicy } = workloadToPod(workload, INSTANCE_ID, NAMESPACE);

		const allTrafficRule = networkPolicy!.spec.egress![1]!;
		const ipBlock = allTrafficRule.to!.find((t) => t.ipBlock)?.ipBlock;
		expect(ipBlock).toBeDefined();
		const exceptions = ipBlock!.except ?? [];
		expect(exceptions.some((e) => e === "169.254.0.0/16" || e === "169.254.169.254/32")).toBe(true);
	});

	test("NetworkPolicy blocks link-local range (covers metadata server) for restricted access", () => {
		const workload = makeWorkload({ network: { access: "restricted" } });
		const { networkPolicy } = workloadToPod(workload, INSTANCE_ID, NAMESPACE);

		const httpsRule = networkPolicy!.spec.egress![1]!;
		const ipBlock = httpsRule.to!.find((t) => t.ipBlock)?.ipBlock;
		expect(ipBlock).toBeDefined();
		const exceptions = ipBlock!.except ?? [];
		expect(exceptions.some((e) => e === "169.254.0.0/16" || e === "169.254.169.254/32")).toBe(true);
	});
});
