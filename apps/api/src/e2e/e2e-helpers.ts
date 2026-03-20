import { randomBytes } from "node:crypto";
import { FakeRuntime, generateNodeId, resolveWorkloadConfig, DEFAULT_RUNTIME_SOCKET } from "@boilerhouse/core";
import type { Runtime, Workload, WorkloadConfig } from "@boilerhouse/core";
import { PodmanRuntime } from "@boilerhouse/runtime-podman";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDatabase, ActivityLog, nodes } from "@boilerhouse/db";
import type { DrizzleDb } from "@boilerhouse/db";
import { createLogger } from "@boilerhouse/o11y";
import { InstanceManager } from "../instance-manager";
import { SnapshotManager } from "../snapshot-manager";
import { TenantManager } from "../tenant-manager";
import { TenantDataStore } from "../tenant-data";
import { EventBus } from "../event-bus";
import { GoldenCreator } from "../golden-creator";
import { BootstrapLogStore } from "../bootstrap-log-store";
import { ResourceLimiter } from "../resource-limits";
import { SecretStore } from "../secret-store";
import { createApp } from "../app";
import { E2E_TIMEOUTS } from "./runtime-matrix";

type RuntimeOperation =
	| "create"
	| "start"
	| "destroy"
	| "snapshot"
	| "restore"
	| "exec"
	| "getEndpoint"
	| "list";

export interface E2EServer {
	/** Base URL including port, e.g. "http://localhost:54321" */
	baseUrl: string;
	/** Direct DB handle for read assertions only */
	db: DrizzleDb;
	/** Stops server, destroys resources, removes temp files */
	cleanup: () => Promise<void>;
	/**
	 * Mutable set controlling FakeRuntime failure injection.
	 * Only present when runtimeName is "fake".
	 * Add operation names to make the runtime throw.
	 */
	fakeFailOn?: Set<RuntimeOperation>;
	/** Secret store for managing tenant secrets. Present when secret gateway is enabled. */
	secretStore?: SecretStore;
}

/**
 * Boots the API server with the given runtime wired in.
 * Starts on a random port and returns a handle for tests.
 */
export async function startE2EServer(runtimeName: string): Promise<E2EServer> {
	const db = createTestDatabase();
	const nodeId = generateNodeId();
	const activityLog = new ActivityLog(db);
	const eventBus = new EventBus();

	// Insert a node so FK constraints pass
	db.insert(nodes)
		.values({
			nodeId,
			runtimeType: "podman",
			capacity: { vcpus: 8, memoryMb: 16384, diskGb: 100 },
			status: "online",
			lastHeartbeat: new Date(),
			createdAt: new Date(),
		})
		.run();

	// Secret store setup
	const secretKey = randomBytes(32).toString("hex");
	const secretStore = new SecretStore(db, secretKey);

	let runtime: Runtime;
	let fakeFailOn: Set<RuntimeOperation> | undefined;
	let snapshotDir: string | undefined;

	if (runtimeName === "fake") {
		fakeFailOn = new Set<RuntimeOperation>();
		runtime = new FakeRuntime({ failOn: fakeFailOn });
	} else if (runtimeName === "podman") {
		snapshotDir = mkdtempSync(join(tmpdir(), "bh-e2e-snap-"));
		const socketPath = process.env.RUNTIME_SOCKET ?? DEFAULT_RUNTIME_SOCKET;
		runtime = new PodmanRuntime({ snapshotDir, socketPath });
	} else if (runtimeName === "kubernetes") {
		const { KubernetesRuntime } = await import("@boilerhouse/runtime-kubernetes");

		snapshotDir = mkdtempSync(join(tmpdir(), "bh-e2e-k8s-snap-"));
		const ip = Bun.spawnSync(["minikube", "ip", "-p", "boilerhouse-test"], {
			stdout: "pipe",
		}).stdout.toString().trim();
		const token = Bun.spawnSync(
			["kubectl", "--context", "boilerhouse-test", "-n", "boilerhouse",
			 "create", "token", "default"],
			{ stdout: "pipe" },
		).stdout.toString().trim();

		runtime = new KubernetesRuntime({
			auth: "external",
			apiUrl: `https://${ip}:8443`,
			token,
			namespace: "boilerhouse",
			context: "boilerhouse-test",
			minikubeProfile: "boilerhouse-test",
			snapshotDir,
		});
	} else {
		throw new Error(`Runtime '${runtimeName}' not implemented for E2E`);
	}

	const log = createLogger("e2e");
	const instanceManager = new InstanceManager(
		runtime,
		db,
		activityLog,
		nodeId,
		eventBus,
		log,
		secretStore,
	);
	const snapshotManager = new SnapshotManager(runtime, db, nodeId, {
		...(runtimeName === "fake" ? { healthChecker: async () => {} } : {}),
		secretStore,
	});
	const tenantDataStore = new TenantDataStore("/tmp/boilerhouse-e2e", db);
	const tenantManager = new TenantManager(
		instanceManager,
		snapshotManager,
		db,
		activityLog,
		nodeId,
		tenantDataStore,
		undefined,
		log,
		eventBus,
	);

	const resourceLimiter = new ResourceLimiter(db, { maxInstances: 100 });
	const bootstrapLogStore = new BootstrapLogStore(db);
	const goldenCreator = new GoldenCreator(db, snapshotManager, eventBus, bootstrapLogStore);

	const app = createApp({
		db,
		runtime,
		nodeId,
		activityLog,
		instanceManager,
		tenantManager,
		snapshotManager,
		eventBus,
		goldenCreator,
		bootstrapLogStore,
		resourceLimiter,
		secretStore,
		log,
	});

	const server = app.listen(0);
	const port = server.server!.port;
	const baseUrl = `http://localhost:${port}`;

	return {
		baseUrl,
		db,
		fakeFailOn,
		secretStore,
		cleanup: async () => {
			server.stop();
			resourceLimiter.dispose();
			// Destroy any remaining containers for real runtimes
			if (runtimeName !== "fake") {
				const remaining = await runtime.list();
				for (const id of remaining) {
					await runtime.destroy({ instanceId: id, running: false }).catch(() => {});
				}
			}
		},
	};
}

/**
 * Waits for a workload to reach "ready" status by polling.
 * Throws if the workload doesn't become ready within the timeout.
 */
export async function waitForWorkloadReady(
	server: E2EServer,
	workloadName: string,
	timeoutMs = 30_000,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const res = await fetch(
			`${server.baseUrl}/api/v1/workloads/${encodeURIComponent(workloadName)}`,
		);
		if (res.ok) {
			const body = (await res.json()) as { status: string };
			if (body.status === "ready") return;
			if (body.status === "error") {
				throw new Error(`Workload '${workloadName}' failed to create golden snapshot`);
			}
		}
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`Workload '${workloadName}' did not become ready within ${timeoutMs}ms`);
}

/**
 * Typed fetch wrapper against the E2E server.
 * Handles JSON serialization of request bodies.
 */
export async function api(
	server: E2EServer,
	method: string,
	path: string,
	body?: unknown,
): Promise<Response> {
	const url = `${server.baseUrl}${path}`;
	const headers: Record<string, string> = {};
	let reqBody: string | undefined;

	if (body !== undefined) {
		if (typeof body === "string") {
			headers["Content-Type"] = "text/plain";
			reqBody = body;
		} else {
			headers["Content-Type"] = "application/json";
			reqBody = JSON.stringify(body);
		}
	}

	return fetch(url, {
		method,
		headers,
		body: reqBody,
	});
}

/**
 * Imports a workload fixture `.ts` file and resolves it to a canonical
 * {@link Workload} object ready for JSON serialization to the API.
 */
export async function readFixture(path: string): Promise<Workload> {
	const mod = await import(path);
	return resolveWorkloadConfig(mod.default as WorkloadConfig);
}

/**
 * Returns the operation timeout for a given runtime.
 */
export function timeoutFor(
	runtimeName: string,
): (typeof E2E_TIMEOUTS)[keyof typeof E2E_TIMEOUTS] {
	return (
		E2E_TIMEOUTS[runtimeName as keyof typeof E2E_TIMEOUTS] ??
		E2E_TIMEOUTS.fake
	);
}
