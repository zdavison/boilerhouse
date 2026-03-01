import { mkdirSync } from "node:fs";
import { eq } from "drizzle-orm";
import { FakeRuntime, generateNodeId } from "@boilerhouse/core";
import type { Runtime, RuntimeType, Workload } from "@boilerhouse/core";
import { PodmanRuntime } from "@boilerhouse/runtime-podman";
import { initDatabase, ActivityLog, loadWorkloadsFromDir } from "@boilerhouse/db";
import { workloads as workloadsTable, tenants } from "@boilerhouse/db";
import { nodes } from "@boilerhouse/db";
import { createLogger } from "@boilerhouse/logger";
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

const log = createLogger("server");

const port = Number(process.env.PORT ?? 3000);
const dbPath = process.env.DB_PATH ?? "boilerhouse.db";
const storagePath = process.env.STORAGE_PATH ?? "./data";
const snapshotDir = process.env.SNAPSHOT_DIR ?? "./data/snapshots";
const runtimeType = (process.env.RUNTIME_TYPE ?? "podman") as RuntimeType;
const maxInstances = Number(process.env.MAX_INSTANCES ?? 100);
const workloadsDir = process.env.WORKLOADS_DIR;
const podmanSocket = process.env.PODMAN_SOCKET ?? "/run/boilerhouse/podman.sock";

// Ensure data directories exist
mkdirSync(snapshotDir, { recursive: true });
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

let runtime: Runtime;
if (runtimeType === "podman") {
	runtime = new PodmanRuntime({
		snapshotDir,
		socketPath: podmanSocket,
		workloadsDir: workloadsDir ? workloadsDir : undefined,
	});
} else {
	runtime = new FakeRuntime();
}
const activityLog = new ActivityLog(db);
const eventBus = new EventBus();

// Load workload definitions from disk if configured
if (workloadsDir) {
	const result = loadWorkloadsFromDir(db, workloadsDir);
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
);
const snapshotManager = new SnapshotManager(runtime, db, nodeId);
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
	log: createLogger("routes"),
});

app.listen(port);

log.info({ port }, "Boilerhouse API listening");
