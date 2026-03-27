import { describe, test, expect, beforeEach } from "bun:test";
import { Readable } from "node:stream";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DockerClient, ContainerCreateBody } from "./client";
import type { DockerSidecar, SidecarState } from "./sidecar";
import type { DockerImageResolver } from "./image-resolver";
import { DockerRuntime } from "./runtime";
import type { InstanceHandle, InstanceId, Workload } from "@boilerhouse/core";
import { generateInstanceId } from "@boilerhouse/core";

// ── Fixtures ─────────────────────────────────────────────────────────────────

function minimalWorkload(): Workload {
	return {
		workload: { name: "test-service", version: "1.0.0" },
		image: { ref: "test:latest" },
		resources: { vcpus: 1, memory_mb: 256, disk_gb: 2 },
		network: { access: "none" },
		idle: { action: "hibernate" },
	};
}

function bridgeWorkload(): Workload {
	return {
		workload: { name: "web-service", version: "1.0.0" },
		image: { ref: "test:latest" },
		resources: { vcpus: 1, memory_mb: 256, disk_gb: 2 },
		network: { access: "public", expose: [{ guest: 8080 }] },
		idle: { action: "hibernate" },
	};
}

function overlayWorkload(dirs: string[]): Workload {
	return {
		workload: { name: "overlay-service", version: "1.0.0" },
		image: { ref: "test:latest" },
		resources: { vcpus: 1, memory_mb: 256, disk_gb: 2 },
		network: { access: "none" },
		idle: { action: "hibernate" },
		filesystem: { overlay_dirs: dirs },
	};
}

// ── Mock factory ──────────────────────────────────────────────────────────────

interface MockCall<T = unknown[]> {
	args: T;
}

function createMockClient() {
	const calls = {
		ping: [] as MockCall<[]>[],
		listContainers: [] as MockCall<[]>[],
		createContainer: [] as MockCall<[string, ContainerCreateBody]>[],
		startContainer: [] as MockCall<[string]>[],
		removeContainer: [] as MockCall<[string]>[],
		pauseContainer: [] as MockCall<[string]>[],
		unpauseContainer: [] as MockCall<[string]>[],
		inspectContainer: [] as MockCall<[string]>[],
		exec: [] as MockCall<[string, string[]]>[],
		execWithStdin: [] as MockCall<[string, string[], Buffer]>[],
		putArchive: [] as MockCall<[string, string, Buffer]>[],
		containerLogs: [] as MockCall<[string, number]>[],
	};

	let pingResult = true;
	let listResult: string[] = [];
	let execResult = { exitCode: 0, stdout: "", stderr: "" };
	let inspectResult = {
		Id: "fake-id",
		State: { Running: true, Status: "running" },
		NetworkSettings: {
			Ports: {} as Record<string, Array<{ HostIp: string; HostPort: string }> | null>,
		},
	};
	let logsResult = "log output";
	let logsError: Error | null = null;

	const client = {
		ping: async () => { calls.ping.push({ args: [] }); return pingResult; },
		listContainers: async () => { calls.listContainers.push({ args: [] }); return listResult; },
		createContainer: async (name: string, body: ContainerCreateBody) => {
			calls.createContainer.push({ args: [name, body] });
			return "fake-container-id";
		},
		startContainer: async (id: string) => { calls.startContainer.push({ args: [id] }); },
		removeContainer: async (id: string) => { calls.removeContainer.push({ args: [id] }); },
		pauseContainer: async (id: string) => { calls.pauseContainer.push({ args: [id] }); },
		unpauseContainer: async (id: string) => { calls.unpauseContainer.push({ args: [id] }); },
		inspectContainer: async (id: string) => {
			calls.inspectContainer.push({ args: [id] });
			return inspectResult;
		},
		exec: async (id: string, cmd: string[]) => {
			calls.exec.push({ args: [id, cmd] });
			return execResult;
		},
		execWithStdin: async (id: string, cmd: string[], data: Buffer) => {
			calls.execWithStdin.push({ args: [id, cmd, data] });
			return execResult;
		},
		putArchive: async (id: string, dest: string, tar: Buffer) => {
			calls.putArchive.push({ args: [id, dest, tar] });
		},
		containerLogs: async (id: string, tail: number) => {
			calls.containerLogs.push({ args: [id, tail] });
			if (logsError) throw logsError;
			return logsResult;
		},
	} as unknown as DockerClient;

	return {
		client,
		calls,
		setPing: (v: boolean) => { pingResult = v; },
		setList: (v: string[]) => { listResult = v; },
		setExec: (v: typeof execResult) => { execResult = v; },
		setInspect: (v: typeof inspectResult) => { inspectResult = v; },
		setLogs: (v: string) => { logsResult = v; },
		setLogsError: (e: Error | null) => { logsError = e; },
	};
}

function createMockImageResolver(imageRef = "test:latest") {
	return {
		ensure: async () => ({ imageRef, localBuild: false }),
	} as unknown as DockerImageResolver;
}

function createMockSidecar() {
	const calls = {
		create: [] as MockCall<unknown[]>[],
		start: [] as MockCall<[string]>[],
		destroy: [] as MockCall<[string, SidecarState]>[],
	};

	const sidecar = {
		create: async (id: string, opts: unknown) => {
			calls.create.push({ args: [id, opts] });
			return { configPath: "/tmp/fake.yaml" } as SidecarState;
		},
		start: async (id: string) => { calls.start.push({ args: [id] }); },
		destroy: async (id: string, state: SidecarState) => {
			calls.destroy.push({ args: [id, state] });
		},
		prepareCaCert: () => ({ caCertPath: "/tmp/ca.crt", binds: [], env: {} }),
	} as unknown as DockerSidecar;

	return { sidecar, calls };
}

/** Creates a DockerRuntime with all internals replaced by mocks. */
function createTestRuntime() {
	const runtime = new DockerRuntime({ socketPath: "/nonexistent" });
	const mock = createMockClient();
	const imageResolver = createMockImageResolver();
	const sidecarMock = createMockSidecar();

	(runtime as unknown as Record<string, unknown>).client = mock.client;
	(runtime as unknown as Record<string, unknown>).imageResolver = imageResolver;
	(runtime as unknown as Record<string, unknown>).sidecar = sidecarMock.sidecar;

	return { runtime, mock, imageResolver, sidecarMock };
}

/** Directly registers a fake instance in the runtime's private map. */
function registerFakeInstance(
	runtime: DockerRuntime,
	instanceId: InstanceId,
	opts: {
		running?: boolean;
		ports?: number[];
		hasSidecar?: boolean;
		sidecarState?: SidecarState;
		overlayDirMap?: Map<string, string>;
	} = {},
) {
	const instances = (runtime as unknown as Record<string, unknown>).instances as Map<string, unknown>;
	instances.set(instanceId, {
		instanceId,
		running: opts.running ?? false,
		ports: opts.ports ?? [],
		hasSidecar: opts.hasSidecar ?? false,
		sidecarState: opts.sidecarState,
		overlayDirMap: opts.overlayDirMap,
	});
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("DockerRuntime", () => {
	let runtime: DockerRuntime;
	let mock: ReturnType<typeof createMockClient>;
	let sidecarMock: ReturnType<typeof createMockSidecar>;

	beforeEach(() => {
		const ctx = createTestRuntime();
		runtime = ctx.runtime;
		mock = ctx.mock;
		sidecarMock = ctx.sidecarMock;
	});

	// ── available() ──────────────────────────────────────────────────────────

	describe("available()", () => {
		test("returns true when daemon is reachable", async () => {
			mock.setPing(true);
			expect(await runtime.available()).toBe(true);
			expect(mock.calls.ping).toHaveLength(1);
		});

		test("returns false when daemon is unreachable", async () => {
			mock.setPing(false);
			expect(await runtime.available()).toBe(false);
		});
	});

	// ── list() ───────────────────────────────────────────────────────────────

	describe("list()", () => {
		test("delegates to client.listContainers()", async () => {
			mock.setList(["inst-abc", "inst-def"]);
			const result = await runtime.list();
			expect(result).toEqual(["inst-abc", "inst-def"]);
			expect(mock.calls.listContainers).toHaveLength(1);
		});
	});

	// ── logs() ───────────────────────────────────────────────────────────────

	describe("logs()", () => {
		test("returns log output from client", async () => {
			const instanceId = generateInstanceId();
			registerFakeInstance(runtime, instanceId, { running: true });
			mock.setLogs("line1\nline2");

			const result = await runtime.logs({ instanceId, running: true }, 50);
			expect(result).toBe("line1\nline2");
			expect(mock.calls.containerLogs[0]?.args[1]).toBe(50);
		});

		test("returns null when client throws", async () => {
			const instanceId = generateInstanceId();
			registerFakeInstance(runtime, instanceId, { running: true });
			mock.setLogsError(new Error("container not found"));

			const result = await runtime.logs({ instanceId, running: true });
			expect(result).toBeNull();
		});
	});

	// ── exec() ───────────────────────────────────────────────────────────────

	describe("exec()", () => {
		test("delegates to client.exec() when no stdin", async () => {
			const instanceId = generateInstanceId();
			mock.setExec({ exitCode: 0, stdout: "hello", stderr: "" });

			const result = await runtime.exec({ instanceId, running: true }, ["echo", "hello"]);
			expect(result.stdout).toBe("hello");
			expect(mock.calls.exec[0]?.args).toEqual([instanceId, ["echo", "hello"]]);
		});

		test("delegates to client.execWithStdin() when stdin provided", async () => {
			const instanceId = generateInstanceId();
			mock.setExec({ exitCode: 0, stdout: "piped", stderr: "" });

			const stdin = Readable.from(["piped input"]);
			const result = await runtime.exec(
				{ instanceId, running: true },
				["cat"],
				{ stdin },
			);

			expect(result.stdout).toBe("piped");
			expect(mock.calls.execWithStdin).toHaveLength(1);
			const [calledId, calledCmd, calledData] = mock.calls.execWithStdin[0]!.args;
			expect(calledId).toBe(instanceId);
			expect(calledCmd).toEqual(["cat"]);
			expect(calledData.toString()).toBe("piped input");
		});
	});

	// ── pause() / unpause() ───────────────────────────────────────────────────

	describe("pause() / unpause()", () => {
		test("pause() delegates to client.pauseContainer()", async () => {
			const instanceId = generateInstanceId();
			await runtime.pause({ instanceId, running: true });
			expect(mock.calls.pauseContainer[0]?.args[0]).toBe(instanceId);
		});

		test("unpause() delegates to client.unpauseContainer()", async () => {
			const instanceId = generateInstanceId();
			await runtime.unpause({ instanceId, running: true });
			expect(mock.calls.unpauseContainer[0]?.args[0]).toBe(instanceId);
		});
	});

	// ── getEndpoint() ─────────────────────────────────────────────────────────

	describe("getEndpoint()", () => {
		test("resolves host ports from inspectContainer", async () => {
			const instanceId = generateInstanceId();
			registerFakeInstance(runtime, instanceId);
			mock.setInspect({
				Id: instanceId,
				State: { Running: true, Status: "running" },
				NetworkSettings: {
					Ports: {
						"8080/tcp": [{ HostIp: "0.0.0.0", HostPort: "32768" }],
					},
				},
			});

			const endpoint = await runtime.getEndpoint({ instanceId, running: true });
			expect(endpoint.host).toBe("127.0.0.1");
			expect(endpoint.ports).toEqual([32768]);
		});

		test("caches ports after first resolve", async () => {
			const instanceId = generateInstanceId();
			registerFakeInstance(runtime, instanceId);
			mock.setInspect({
				Id: instanceId,
				State: { Running: true, Status: "running" },
				NetworkSettings: {
					Ports: { "8080/tcp": [{ HostIp: "0.0.0.0", HostPort: "40000" }] },
				},
			});

			await runtime.getEndpoint({ instanceId, running: true });
			await runtime.getEndpoint({ instanceId, running: true });

			// inspectContainer called only once; second call uses cached ports
			expect(mock.calls.inspectContainer).toHaveLength(1);
		});

		test("returns empty ports when inspect has no bindings", async () => {
			const instanceId = generateInstanceId();
			registerFakeInstance(runtime, instanceId);
			mock.setInspect({
				Id: instanceId,
				State: { Running: true, Status: "running" },
				NetworkSettings: { Ports: {} },
			});

			const endpoint = await runtime.getEndpoint({ instanceId, running: true });
			expect(endpoint.ports).toEqual([]);
		});
	});

	// ── statOverlayDirs() ─────────────────────────────────────────────────────

	describe("statOverlayDirs()", () => {
		test("returns null for empty dirs", async () => {
			const instanceId = generateInstanceId();
			const result = await runtime.statOverlayDirs(instanceId, { instanceId, running: true }, []);
			expect(result).toBeNull();
			expect(mock.calls.exec).toHaveLength(0);
		});

		test("returns Date when exec returns epoch seconds", async () => {
			const instanceId = generateInstanceId();
			mock.setExec({ exitCode: 0, stdout: "1700000000", stderr: "" });

			const result = await runtime.statOverlayDirs(instanceId, { instanceId, running: true }, ["/data"]);
			expect(result).toEqual(new Date(1700000000 * 1000));
		});

		test("returns null when exec exits with non-zero code", async () => {
			const instanceId = generateInstanceId();
			mock.setExec({ exitCode: 1, stdout: "", stderr: "permission denied" });

			const result = await runtime.statOverlayDirs(instanceId, { instanceId, running: true }, ["/data"]);
			expect(result).toBeNull();
		});

		test("returns new Date(0) when exec output is empty", async () => {
			const instanceId = generateInstanceId();
			mock.setExec({ exitCode: 0, stdout: "", stderr: "" });

			const result = await runtime.statOverlayDirs(instanceId, { instanceId, running: true }, ["/data"]);
			expect(result).toEqual(new Date(0));
		});

		test("returns null when exec output is not a number", async () => {
			const instanceId = generateInstanceId();
			mock.setExec({ exitCode: 0, stdout: "not-a-number", stderr: "" });

			const result = await runtime.statOverlayDirs(instanceId, { instanceId, running: true }, ["/data"]);
			expect(result).toBeNull();
		});
	});

	// ── extractOverlayArchive() ───────────────────────────────────────────────

	describe("extractOverlayArchive()", () => {
		test("returns null when instance is not tracked", async () => {
			const instanceId = generateInstanceId();
			const result = await runtime.extractOverlayArchive(instanceId, ["/data"]);
			expect(result).toBeNull();
		});

		test("returns null when instance has no overlayDirMap", async () => {
			const instanceId = generateInstanceId();
			registerFakeInstance(runtime, instanceId);

			const result = await runtime.extractOverlayArchive(instanceId, ["/data"]);
			expect(result).toBeNull();
		});

		test("returns null when overlayDirs parameter is empty", async () => {
			const instanceId = generateInstanceId();
			const hostDir = join(tmpdir(), `bh-test-overlay-${Date.now()}`);
			mkdirSync(hostDir, { recursive: true });
			registerFakeInstance(runtime, instanceId, {
				overlayDirMap: new Map([["/data", hostDir]]),
			});

			const result = await runtime.extractOverlayArchive(instanceId, []);
			expect(result).toBeNull();
		});
	});

	// ── injectArchive() ───────────────────────────────────────────────────────

	describe("injectArchive()", () => {
		test("calls client.putArchive() when no overlay dirs are configured", async () => {
			const instanceId = generateInstanceId();
			// Instance without overlayDirMap (or not tracked at all)
			const tar = Buffer.from("fake-tar-data");

			await runtime.injectArchive(instanceId, "/workspace", tar);

			expect(mock.calls.putArchive).toHaveLength(1);
			const [id, dest, data] = mock.calls.putArchive[0]!.args;
			expect(id).toBe(instanceId);
			expect(dest).toBe("/workspace");
			expect(data).toEqual(tar);
		});
	});

	// ── create() ─────────────────────────────────────────────────────────────

	describe("create()", () => {
		test("returns handle with running=false", async () => {
			const instanceId = generateInstanceId();
			const handle = await runtime.create(minimalWorkload(), instanceId);
			expect(handle.instanceId).toBe(instanceId);
			expect(handle.running).toBe(false);
		});

		test("calls imageResolver.ensure() and client.createContainer()", async () => {
			const instanceId = generateInstanceId();
			await runtime.create(minimalWorkload(), instanceId);

			expect(mock.calls.createContainer).toHaveLength(1);
			expect(mock.calls.createContainer[0]?.args[0]).toBe(instanceId);
		});

		test("registers instance in internal map", async () => {
			const instanceId = generateInstanceId();
			await runtime.create(minimalWorkload(), instanceId);

			const instances = (runtime as unknown as Record<string, unknown>).instances as Map<string, unknown>;
			expect(instances.has(instanceId)).toBe(true);
		});

		test("sets NetworkMode=none for network.access='none'", async () => {
			const instanceId = generateInstanceId();
			await runtime.create(minimalWorkload(), instanceId);

			const [, body] = mock.calls.createContainer[0]!.args;
			expect(body.HostConfig.NetworkMode).toBe("none");
			expect(body.HostConfig.PortBindings).toBeUndefined();
		});

		test("configures port bindings for non-isolated network", async () => {
			const instanceId = generateInstanceId();
			await runtime.create(bridgeWorkload(), instanceId);

			const [, body] = mock.calls.createContainer[0]!.args;
			expect(body.HostConfig.NetworkMode).toBe("bridge");
			expect(body.HostConfig.PortBindings?.["8080/tcp"]).toEqual([{ HostPort: "0" }]);
		});

		test("creates overlayDirMap when workload has overlay_dirs", async () => {
			const instanceId = generateInstanceId();
			await runtime.create(overlayWorkload(["/data", "/config"]), instanceId);

			const instances = (runtime as unknown as Record<string, unknown>).instances as Map<string, {
				overlayDirMap?: Map<string, string>;
			}>;
			const inst = instances.get(instanceId);
			expect(inst?.overlayDirMap).toBeDefined();
			expect(inst?.overlayDirMap?.size).toBe(2);
			expect(inst?.overlayDirMap?.has("/data")).toBe(true);
			expect(inst?.overlayDirMap?.has("/config")).toBe(true);

			// Host dirs should exist on the filesystem
			for (const hostDir of inst!.overlayDirMap!.values()) {
				expect(existsSync(hostDir)).toBe(true);
			}
		});

		test("does not create sidecar when no proxyConfig", async () => {
			const instanceId = generateInstanceId();
			await runtime.create(bridgeWorkload(), instanceId);
			expect(sidecarMock.calls.create).toHaveLength(0);
		});
	});

	// ── start() ──────────────────────────────────────────────────────────────

	describe("start()", () => {
		test("starts the container", async () => {
			const instanceId = generateInstanceId();
			registerFakeInstance(runtime, instanceId);

			await runtime.start({ instanceId, running: false });
			expect(mock.calls.startContainer[0]?.args[0]).toBe(instanceId);
		});

		test("starts sidecar when hasSidecar=true", async () => {
			const instanceId = generateInstanceId();
			registerFakeInstance(runtime, instanceId, { hasSidecar: true });

			await runtime.start({ instanceId, running: false });
			expect(sidecarMock.calls.start[0]?.args[0]).toBe(instanceId);
		});

		test("does not start sidecar when hasSidecar=false", async () => {
			const instanceId = generateInstanceId();
			registerFakeInstance(runtime, instanceId, { hasSidecar: false });

			await runtime.start({ instanceId, running: false });
			expect(sidecarMock.calls.start).toHaveLength(0);
		});

		test("marks instance as running", async () => {
			const instanceId = generateInstanceId();
			registerFakeInstance(runtime, instanceId);
			const handle: InstanceHandle = { instanceId, running: false };

			await runtime.start(handle);
			expect(handle.running).toBe(true);
		});
	});

	// ── destroy() ─────────────────────────────────────────────────────────────

	describe("destroy()", () => {
		test("calls client.removeContainer()", async () => {
			const instanceId = generateInstanceId();
			registerFakeInstance(runtime, instanceId);

			await runtime.destroy({ instanceId, running: true });
			expect(mock.calls.removeContainer[0]?.args[0]).toBe(instanceId);
		});

		test("removes instance from internal map", async () => {
			const instanceId = generateInstanceId();
			registerFakeInstance(runtime, instanceId);

			await runtime.destroy({ instanceId, running: true });

			const instances = (runtime as unknown as Record<string, unknown>).instances as Map<string, unknown>;
			expect(instances.has(instanceId)).toBe(false);
		});

		test("calls sidecar.destroy() when hasSidecar=true", async () => {
			const instanceId = generateInstanceId();
			const sidecarState: SidecarState = { configPath: "/tmp/fake.yaml" };
			registerFakeInstance(runtime, instanceId, { hasSidecar: true, sidecarState });

			await runtime.destroy({ instanceId, running: true });
			expect(sidecarMock.calls.destroy).toHaveLength(1);
			expect(sidecarMock.calls.destroy[0]?.args[0]).toBe(instanceId);
		});

		test("does not call sidecar.destroy() when hasSidecar=false", async () => {
			const instanceId = generateInstanceId();
			registerFakeInstance(runtime, instanceId, { hasSidecar: false });

			await runtime.destroy({ instanceId, running: true });
			expect(sidecarMock.calls.destroy).toHaveLength(0);
		});

		test("is safe for untracked instances (no-op on map)", async () => {
			const instanceId = generateInstanceId();
			// Not registered — should not throw
			await expect(runtime.destroy({ instanceId, running: false })).resolves.toBeUndefined();
			expect(mock.calls.removeContainer).toHaveLength(1);
		});
	});
});
