import { eq } from "drizzle-orm";
import { FakeRuntime, generateNodeId } from "@boilerhouse/core";
import type { Workload } from "@boilerhouse/core";
import { initDatabase, ActivityLog, loadWorkloadsFromDir } from "@boilerhouse/db";
import { workloads as workloadsTable, tenants } from "@boilerhouse/db";
import { nodes } from "@boilerhouse/db";
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

const port = Number(process.env.PORT ?? 3000);
const dbPath = process.env.DB_PATH ?? "boilerhouse.db";
const storagePath = process.env.STORAGE_PATH ?? "./data";
const maxInstances = Number(process.env.MAX_INSTANCES ?? 100);
const workloadsDir = process.env.WORKLOADS_DIR;

const db = initDatabase(dbPath);
const existingNode = db.select().from(nodes).get();
const nodeId = existingNode ? existingNode.nodeId : generateNodeId();

if (!existingNode) {
	db.insert(nodes)
		.values({
			nodeId,
			// TODO: Replace with actual runtime type once PodmanRuntime is implemented
			runtimeType: "podman",
			capacity: { vcpus: 8, memoryMb: 16384, diskGb: 100 },
			status: "online",
			lastHeartbeat: new Date(),
			createdAt: new Date(),
		})
		.run();
}

// TODO: Replace FakeRuntime with PodmanRuntime once implemented
const runtime = new FakeRuntime();
const activityLog = new ActivityLog(db);
const eventBus = new EventBus();

// Load workload definitions from disk if configured
if (workloadsDir) {
	const result = loadWorkloadsFromDir(db, workloadsDir);
	console.log(
		`Workloads: ${result.loaded} loaded, ${result.updated} updated, ${result.unchanged} unchanged, ${result.errors.length} error(s)`,
	);
	for (const { file, error } of result.errors) {
		console.error(`  ${file}: ${error}`);
	}
}

const instanceManager = new InstanceManager(runtime, db, activityLog, nodeId, eventBus);
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
		console.log(`Idle timeout: instance=${instanceId} has no tenant — skipping`);
		return;
	}

	console.log(`Idle timeout: instance=${instanceId} tenant=${tenantRow.tenantId} action=${action}`);
	await tenantManager.release(tenantRow.tenantId);
});

// Recover state before accepting requests
const report = await recoverState(runtime, db, nodeId, activityLog);

const recoverySummary = [
	`${report.recovered} recovered`,
	`${report.destroyed} destroyed`,
	`${report.tenantsReset} tenants reset`,
].join(", ");
console.log(`Recovery: ${recoverySummary}`);

const bootstrapLogStore = new BootstrapLogStore(db);
const goldenCreator = new GoldenCreator(db, snapshotManager, eventBus, bootstrapLogStore);

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
		console.log(`Golden snapshots: ${enqueued} enqueued for background creation`);
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
});

app.listen(port);

console.log(`Boilerhouse API listening on http://localhost:${port}`);
