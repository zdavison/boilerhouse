import { mkdirSync } from "node:fs";
import { eq } from "drizzle-orm";
import { FakeRuntime, generateNodeId } from "@boilerhouse/core";
import type { Runtime, RuntimeType, Workload } from "@boilerhouse/core";
import { DockerRuntime } from "@boilerhouse/runtime-docker";
import { initDatabase, ActivityLog, loadWorkloadsFromDir } from "@boilerhouse/db";
import { claims } from "@boilerhouse/db";
import { nodes } from "@boilerhouse/db";
import {
	createLogger,
	initO11y,
	instrumentFromEventBus,
	wrapTenantManager,
	wrapInstanceManager,
} from "@boilerhouse/o11y";
import { InstanceManager } from "./instance-manager";
import { TenantManager } from "./tenant-manager";
import { TenantDataStore } from "./tenant-data";
import { IdleMonitor } from "./idle-monitor";
import { WatchDirsPoller } from "./watch-dirs-poller";
import { EventBus } from "./event-bus";
import { BootstrapLogStore } from "./bootstrap-log-store";
import { PoolManager } from "./pool-manager";
import { createApp } from "./app";
import { recoverState } from "./recovery";
import { ResourceLimiter } from "./resource-limits";
import { applyWorkloadTransition } from "./transitions";
import { SecretStore } from "./secret-store";
import { prewarmPools } from "./startup-prewarm";

const log = createLogger("server");

const port = Number(process.env.PORT ?? 3000);
const dbPath = process.env.DB_PATH ?? "boilerhouse.db";
const storagePath = process.env.STORAGE_PATH ?? "./data";
const runtimeType = (process.env.RUNTIME_TYPE ?? "docker") as RuntimeType;
const maxInstances = Number(process.env.MAX_INSTANCES ?? 100);
const workloadsDir = process.env.WORKLOADS_DIR;

mkdirSync(storagePath, { recursive: true });

const db = initDatabase(dbPath);
const existingNode = db.select().from(nodes).get();
const nodeId = existingNode ? existingNode.nodeId : generateNodeId();

if (!existingNode) {
	db.insert(nodes)
		.values({
			nodeId,
			runtimeType,
			capacity: { vcpus: 8, memoryMb: 16384, diskGb: 100 },
			status: "online",
			lastHeartbeat: new Date(),
			createdAt: new Date(),
		})
		.run();
}

const activityLog = new ActivityLog(db);
const eventBus = new EventBus();

// Optional API key — when set, all /api/v1 routes (except /health) and /ws require it
const apiKey = process.env.BOILERHOUSE_API_KEY || undefined;
if (apiKey) {
	log.info("API authentication enabled (BOILERHOUSE_API_KEY is set)");
} else {
	log.warn("API authentication disabled — set BOILERHOUSE_API_KEY to require auth");
}

// Encrypted secret store for credential injection (required in production)
const secretKey = process.env.BOILERHOUSE_SECRET_KEY;
if (!secretKey && process.env.NODE_ENV !== "test") {
	log.fatal("BOILERHOUSE_SECRET_KEY is required. Set it to a hex-encoded 32-byte key.");
	process.exit(1);
}

const secretStore = secretKey ? new SecretStore(db, secretKey) : undefined;
if (secretStore) {
	log.info("Secret store initialised.");
}

let runtime: Runtime;
if (runtimeType === "docker") {
	const dockerSocket = process.env.DOCKER_SOCKET;
	const seccompProfilePath = process.env.SECCOMP_PROFILE_PATH;
	log.info({ socketPath: dockerSocket ?? "/var/run/docker.sock" }, "Using Docker runtime");
	runtime = new DockerRuntime({ socketPath: dockerSocket, seccompProfilePath });
} else if (runtimeType === "kubernetes") {
	const { KubernetesRuntime, isInCluster } = await import("@boilerhouse/runtime-kubernetes");

	const k8sNamespace = process.env.K8S_NAMESPACE;
	const k8sContext = process.env.K8S_CONTEXT;
	const k8sMinikubeProfile = process.env.K8S_MINIKUBE_PROFILE;
	const common = { namespace: k8sNamespace, context: k8sContext, minikubeProfile: k8sMinikubeProfile, workloadsDir };

	if (process.env.K8S_API_URL && process.env.K8S_TOKEN) {
		log.info({ apiUrl: process.env.K8S_API_URL, namespace: k8sNamespace }, "Using Kubernetes runtime (external auth)");
		runtime = new KubernetesRuntime({
			auth: "external",
			apiUrl: process.env.K8S_API_URL,
			token: process.env.K8S_TOKEN,
			caCert: process.env.K8S_CA_CERT,
			...common,
		});
	} else if (isInCluster()) {
		log.info({ namespace: k8sNamespace }, "Using Kubernetes runtime (in-cluster auth)");
		runtime = new KubernetesRuntime({ auth: "in-cluster", ...common });
	} else {
		throw new Error(
			"Kubernetes runtime requires either K8S_API_URL + K8S_TOKEN env vars, " +
			"or to be running inside a K8s pod with a mounted service account.",
		);
	}
} else {
	runtime = new FakeRuntime();
}

// Load workload definitions from disk if configured
if (workloadsDir) {
	const result = await loadWorkloadsFromDir(db, workloadsDir);
	log.info(
		{ loaded: result.loaded, updated: result.updated, unchanged: result.unchanged, errors: result.errors.length },
		"Workloads loaded from disk",
	);
	for (const { file, error } of result.errors) {
		log.error({ file, error }, "Failed to load workload");
	}
}

const instanceManager = new InstanceManager(
	runtime, db, activityLog, nodeId, eventBus,
	createLogger("InstanceManager"),
	secretStore,
);
const tenantDataStore = new TenantDataStore(storagePath, db, runtime);
const idleMonitor = new IdleMonitor({ defaultPollIntervalMs: 5000 });
const watchDirsPoller = new WatchDirsPoller(instanceManager, idleMonitor);
const bootstrapLogStore = new BootstrapLogStore(db);

const poolManager = new PoolManager(runtime, db, nodeId, {
	bootstrapLogStore,
	eventBus,
});

const tenantManager = new TenantManager(
	instanceManager,
	db,
	activityLog,
	nodeId,
	tenantDataStore,
	idleMonitor,
	createLogger("TenantManager"),
	eventBus,
	watchDirsPoller,
	poolManager,
);

const resourceLimiter = new ResourceLimiter(db, { maxInstances });

// Release capacity when instances are destroyed or hibernated
eventBus.on((event) => {
	if (
		event.type === "instance.state" &&
		(event.status === "destroyed" || event.status === "hibernated")
	) {
		resourceLimiter.release(nodeId);
	}
});

idleMonitor.onIdle(async (instanceId, action) => {
	const claimRow = db
		.select({ tenantId: claims.tenantId, workloadId: claims.workloadId })
		.from(claims)
		.where(eq(claims.instanceId, instanceId))
		.get();

	if (!claimRow) {
		log.warn({ instanceId }, "Idle timeout: instance has no claim — skipping");
		return;
	}

	log.info({ instanceId, tenantId: claimRow.tenantId, action }, "Idle timeout: releasing tenant");
	await tenantManager.release(claimRow.tenantId, claimRow.workloadId);
});

// Recover state before accepting requests
const report = await recoverState(runtime, db, nodeId, activityLog);

log.info(
	{ recovered: report.recovered, destroyed: report.destroyed, claimsReset: report.claimsReset },
	"Recovery complete",
);

// Pre-warm pools for all workloads that need it at startup (fire-and-forget)
prewarmPools(db, poolManager);

// Start OTEL providers (metrics + tracing)
const { meter, tracer } = initO11y({
	metricsPort: Number(process.env.METRICS_PORT ?? 9464),
	metricsHost: process.env.METRICS_HOST ?? "127.0.0.1",
});

// Subscribe EventBus → metrics
instrumentFromEventBus(meter, {
	eventBus,
	db,
	nodeId,
	maxInstances,
	resourceLimiter,
	poolManager,
});

// Wrap managers with tracing spans
const tracedTenantManager = wrapTenantManager(tenantManager, tracer);
const tracedInstanceManager = wrapInstanceManager(instanceManager, tracer);

const app = createApp({
	db,
	runtime,
	nodeId,
	activityLog,
	apiKey,
	instanceManager: tracedInstanceManager,
	tenantManager: tracedTenantManager,
	eventBus,
	bootstrapLogStore,
	resourceLimiter,
	secretStore: secretStore!,
	poolManager,
	log: createLogger("routes"),
	tracer,
	meter,
});

const listenHost = process.env.LISTEN_HOST ?? "127.0.0.1";
app.listen({ port, hostname: listenHost });

log.info({ port, host: listenHost }, "♨️ Boilerhouse API listening");
log.info({ metricsPort: Number(process.env.METRICS_PORT ?? 9464) }, "Prometheus metrics endpoint started");
