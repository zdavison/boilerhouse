import { mkdirSync, chmodSync } from "node:fs";
import { eq } from "drizzle-orm";
import { FakeRuntime, generateNodeId } from "@boilerhouse/core";
import type { Runtime, RuntimeType, Workload, TenantId } from "@boilerhouse/core";
import { PodmanRuntime } from "@boilerhouse/runtime-podman";
import { initDatabase, ActivityLog, loadWorkloadsFromDir } from "@boilerhouse/db";
import { workloads as workloadsTable, tenants } from "@boilerhouse/db";
import { nodes } from "@boilerhouse/db";
import {
	createLogger,
	initO11y,
	instrumentFromEventBus,
	wrapTenantManager,
	wrapInstanceManager,
	wrapSnapshotManager,
} from "@boilerhouse/o11y";
import { InstanceManager } from "./instance-manager";
import { SnapshotManager } from "./snapshot-manager";
import { TenantManager } from "./tenant-manager";
import { TenantDataStore } from "./tenant-data";
import { IdleMonitor } from "./idle-monitor";
import { EventBus } from "./event-bus";
import { GoldenCreator } from "./golden-creator";
import { BootstrapLogStore } from "./bootstrap-log-store";
import { createApp } from "./app";
import { recoverState } from "./recovery";
import { ResourceLimiter } from "./resource-limits";
import { applyWorkloadTransition, forceWorkloadStatus } from "./transitions";
import { SecretStore } from "./secret-store";
import { ForwardProxy } from "./proxy/proxy";
import { ProxyRegistrar } from "./proxy-registrar";

const log = createLogger("server");

const port = Number(process.env.PORT ?? 3000);
const dbPath = process.env.DB_PATH ?? "boilerhouse.db";
const storagePath = process.env.STORAGE_PATH ?? "./data";
const snapshotDir = process.env.SNAPSHOT_DIR ?? "./data/snapshots";
const runtimeType = (process.env.RUNTIME_TYPE ?? "podman") as RuntimeType;
const maxInstances = Number(process.env.MAX_INSTANCES ?? 100);
const workloadsDir = process.env.WORKLOADS_DIR;
const socketPath = process.env.RUNTIME_SOCKET ?? "/run/boilerhouse/runtime.sock";
const proxyPort = Number(process.env.PROXY_PORT ?? 18080);

// Ensure data directories exist with restrictive permissions
mkdirSync(snapshotDir, { recursive: true, mode: 0o700 });
chmodSync(snapshotDir, 0o700); // enforce on pre-existing dir
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

// Optional: secret gateway (proxy + encrypted secret store)
const secretKey = process.env.BOILERHOUSE_SECRET_KEY;
let secretStore: SecretStore | undefined;
let proxyRegistrar: ProxyRegistrar | undefined;
let forwardProxy: ForwardProxy | undefined;

if (secretKey) {
	secretStore = new SecretStore(db, secretKey);
	forwardProxy = new ForwardProxy({
		port: proxyPort,
		secretResolver: (tenantId, template) =>
			secretStore!.resolveSecretRefs(tenantId as TenantId, template),
	});
	await forwardProxy.start();
	proxyRegistrar = new ProxyRegistrar(forwardProxy, secretStore);
	log.info({ proxyPort: forwardProxy.port }, "Secret gateway proxy started");
} else {
	log.warn("BOILERHOUSE_SECRET_KEY not set — secret gateway proxy disabled, credential injection will not work");
}

let runtime: Runtime;
if (runtimeType === "podman") {
	log.info({ socketPath }, "Using boilerhoused daemon backend");
	runtime = new PodmanRuntime({
		snapshotDir,
		socketPath,
		proxyAddress: forwardProxy ? `http://host.containers.internal:${forwardProxy.port}` : undefined,
	});
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
	proxyRegistrar,
);
const snapshotManager = new SnapshotManager(runtime, db, nodeId, {
	proxyRegistrar,
});
const tenantDataStore = new TenantDataStore(storagePath, db);
const idleMonitor = new IdleMonitor({ defaultPollIntervalMs: 5000 });
const tenantManager = new TenantManager(
	instanceManager,
	snapshotManager,
	db,
	activityLog,
	nodeId,
	tenantDataStore,
	idleMonitor,
	createLogger("TenantManager"),
	eventBus,
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
	const tenantRow = db
		.select({ tenantId: tenants.tenantId })
		.from(tenants)
		.where(eq(tenants.instanceId, instanceId))
		.get();

	if (!tenantRow) {
		log.warn({ instanceId }, "Idle timeout: instance has no tenant — skipping");
		return;
	}

	log.info({ instanceId, tenantId: tenantRow.tenantId, action }, "Idle timeout: releasing tenant");
	await tenantManager.release(tenantRow.tenantId);
});

// Recover state before accepting requests
const report = await recoverState(runtime, db, nodeId, activityLog);

log.info(
	{ recovered: report.recovered, destroyed: report.destroyed, tenantsReset: report.tenantsReset },
	"Recovery complete",
);

const bootstrapLogStore = new BootstrapLogStore(db);
const goldenCreator = new GoldenCreator(
	db, snapshotManager, eventBus, bootstrapLogStore,
	createLogger("GoldenCreator"),
);

// Enqueue golden snapshot creation for workloads that need it
{
	const allWorkloads = db.select().from(workloadsTable).all();
	let enqueued = 0;
	for (const row of allWorkloads) {
		if (!snapshotManager.goldenExists(row.workloadId, nodeId)) {
			// Set status to creating (new workloads already are; error workloads need retry)
			if (row.status === "error") {
				applyWorkloadTransition(db, row.workloadId, "error", "retry");
			} else if (row.status !== "creating") {
				forceWorkloadStatus(db, row.workloadId, "creating");
			}

			goldenCreator.enqueue(row.workloadId, row.config as Workload);
			enqueued++;
		}
	}
	if (enqueued > 0) {
		log.info({ count: enqueued }, "Golden snapshots enqueued for background creation");
	}
}

// Start OTEL providers (metrics + tracing)
const { meter, tracer } = initO11y({
	metricsPort: Number(process.env.METRICS_PORT ?? 9464),
});

// Subscribe EventBus → metrics
instrumentFromEventBus(meter, {
	eventBus,
	db,
	nodeId,
	maxInstances,
	resourceLimiter,
	goldenCreator,
});

// Wrap managers with tracing spans
const tracedTenantManager = wrapTenantManager(tenantManager, tracer);
const tracedInstanceManager = wrapInstanceManager(instanceManager, tracer);
const tracedSnapshotManager = wrapSnapshotManager(snapshotManager, tracer);

const app = createApp({
	db,
	runtime,
	nodeId,
	activityLog,
	instanceManager: tracedInstanceManager,
	tenantManager: tracedTenantManager,
	snapshotManager: tracedSnapshotManager,
	eventBus,
	goldenCreator,
	bootstrapLogStore,
	resourceLimiter,
	secretStore,
	log: createLogger("routes"),
	tracer,
	meter,
});

app.listen(port);

log.info({ port }, "♨️ Boilerhouse API listening");
log.info({ metricsPort: Number(process.env.METRICS_PORT ?? 9464) }, "Prometheus metrics endpoint started");
