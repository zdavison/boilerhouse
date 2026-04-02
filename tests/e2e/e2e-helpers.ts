import { randomBytes } from "node:crypto";
import { FakeRuntime, generateNodeId, resolveWorkloadConfig } from "@boilerhouse/core";
import type { Runtime, Workload, WorkloadConfig } from "@boilerhouse/core";
import { DockerRuntime } from "@boilerhouse/runtime-docker";
import { eq } from "drizzle-orm";
import { createTestDatabase, ActivityLog, nodes, claims } from "@boilerhouse/db";
import type { DrizzleDb } from "@boilerhouse/db";
import { createLogger } from "@boilerhouse/o11y";
import { InstanceManager } from "../../apps/api/src/instance-manager";
import { TenantManager } from "../../apps/api/src/tenant-manager";
import { TenantDataStore } from "../../apps/api/src/tenant-data";
import { EventBus } from "../../apps/api/src/event-bus";
import { AuditLogger } from "../../apps/api/src/audit-logger";
import { BootstrapLogStore } from "../../apps/api/src/bootstrap-log-store";
import { PoolManager } from "../../apps/api/src/pool-manager";
import { ResourceLimiter } from "../../apps/api/src/resource-limits";
import { SecretStore } from "../../apps/api/src/secret-store";
import { IdleMonitor } from "../../apps/api/src/idle-monitor";
import { WatchDirsPoller } from "../../apps/api/src/watch-dirs-poller";
import { createApp } from "../../apps/api/src/app";
import { E2E_TIMEOUTS } from "./runtime-matrix";

type RuntimeOperation =
	| "create"
	| "start"
	| "destroy"
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
	 */
	fakeFailOn?: Set<RuntimeOperation>;
	/** Secret store for managing tenant secrets. Present when secret gateway is enabled. */
	secretStore?: SecretStore;
}

/** Instantiates the runtime for the given name. Extracted so the if/else doesn't live inside startE2EServer. */
async function createRuntime(runtimeName: string): Promise<{ runtime: Runtime; fakeFailOn?: Set<RuntimeOperation> }> {
	if (runtimeName === "fake") {
		const fakeFailOn = new Set<RuntimeOperation>();
		return { runtime: new FakeRuntime({ failOn: fakeFailOn }), fakeFailOn };
	}
	if (runtimeName === "docker") {
		const socketPath = process.env.DOCKER_SOCKET;
		return { runtime: new DockerRuntime({ socketPath }) };
	}
	if (runtimeName === "kubernetes") {
		const { KubernetesRuntime } = await import("@boilerhouse/runtime-kubernetes");
		const apiUrl = Bun.spawnSync(
			["kubectl", "--context", "boilerhouse-test", "config", "view",
			 "--minify", "-o", "jsonpath={.clusters[0].cluster.server}"],
			{ stdout: "pipe" },
		).stdout.toString().trim();
		const token = Bun.spawnSync(
			["kubectl", "--context", "boilerhouse-test", "-n", "boilerhouse",
			 "create", "token", "default"],
			{ stdout: "pipe" },
		).stdout.toString().trim();
		return {
			runtime: new KubernetesRuntime({
				auth: "external",
				apiUrl,
				token,
				namespace: "boilerhouse",
				context: "boilerhouse-test",
				minikubeProfile: "boilerhouse-test",
			}),
		};
	}
	throw new Error(`Runtime '${runtimeName}' not implemented for E2E`);
}

/**
 * Boots the API server with the given runtime wired in.
 * Starts on a random port and returns a handle for tests.
 */
export async function startE2EServer(
	runtimeName: string,
	options?: {
		idlePollIntervalMs?: number;
		/** Optional interceptor to wrap/instrument the runtime before it's wired in. */
		runtimeInterceptor?: (runtime: Runtime) => Runtime;
		/**
		 * Called with the DB handle after the node row is inserted but before any
		 * managers are created. Use this to pre-seed rows (e.g. trigger definitions).
		 */
		onDbReady?: (db: DrizzleDb) => void;
	},
): Promise<E2EServer> {
	const db = createTestDatabase();
	const nodeId = generateNodeId();
	const activityLog = new ActivityLog(db);
	const eventBus = new EventBus();

	db.insert(nodes)
		.values({
			nodeId,
			runtimeType: "docker",
			capacity: { vcpus: 8, memoryMb: 16384, diskGb: 100 },
			status: "online",
			lastHeartbeat: new Date(),
			createdAt: new Date(),
		})
		.run();

	options?.onDbReady?.(db);

	const secretKey = randomBytes(32).toString("hex");
	const secretStore = new SecretStore(db, secretKey);

	let { runtime, fakeFailOn } = await createRuntime(runtimeName);

	if (options?.runtimeInterceptor) {
		runtime = options.runtimeInterceptor(runtime);
	}

	const log = createLogger("e2e");
	const audit = new AuditLogger(activityLog, eventBus, nodeId);
	const instanceManager = new InstanceManager(
		runtime,
		db,
		audit,
		nodeId,
		log,
		secretStore,
	);

	const tenantDataStore = new TenantDataStore("/tmp/boilerhouse-e2e", db, runtime);
	const bootstrapLogStore = new BootstrapLogStore(db);
	const poolManager = new PoolManager(instanceManager, runtime, db, { bootstrapLogStore, audit });

	let idleMonitor: IdleMonitor | undefined;
	let watchDirsPoller: WatchDirsPoller | undefined;

	if (options?.idlePollIntervalMs !== undefined) {
		idleMonitor = new IdleMonitor({ defaultPollIntervalMs: options.idlePollIntervalMs });
		watchDirsPoller = new WatchDirsPoller(instanceManager, idleMonitor, options.idlePollIntervalMs);
	}

	const tenantManager = new TenantManager(
		instanceManager,
		db,
		audit,
		nodeId,
		tenantDataStore,
		{ idleMonitor, log, watchDirsPoller, poolManager },
	);

	if (idleMonitor) {
		idleMonitor.onIdle(async (instanceId, _action) => {
			const claimRow = db
				.select({ tenantId: claims.tenantId, workloadId: claims.workloadId })
				.from(claims)
				.where(eq(claims.instanceId, instanceId))
				.get();

			if (!claimRow) return;
			await tenantManager.release(claimRow.tenantId, claimRow.workloadId);
		});
	}

	const resourceLimiter = new ResourceLimiter(db, { maxInstances: 100 });

	const app = createApp({
		db,
		runtime,
		nodeId,
		activityLog,
		instanceManager,
		tenantManager,
		eventBus,
		bootstrapLogStore,
		resourceLimiter,
		secretStore,
		poolManager,
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
			idleMonitor?.stop();
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
				throw new Error(`Workload '${workloadName}' entered error state`);
			}
		}
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`Workload '${workloadName}' did not become ready within ${timeoutMs}ms`);
}

/**
 * Typed fetch wrapper against the E2E server.
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

	return fetch(url, { method, headers, body: reqBody });
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
