import { generateNodeId } from "@boilerhouse/core";
import { FakeRuntime } from "@boilerhouse/core";
import { initDatabase, ActivityLog } from "@boilerhouse/db";
import { nodes } from "@boilerhouse/db";
import { InstanceManager } from "./instance-manager";
import { SnapshotManager } from "./snapshot-manager";
import { TenantManager } from "./tenant-manager";
import { TenantDataStore } from "./tenant-data";
import { IdleMonitor } from "./idle-monitor";
import { EventBus } from "./event-bus";
import { createApp } from "./app";
import { recoverState } from "./recovery";
import { ResourceLimiter } from "./resource-limits";

const port = Number(process.env.PORT ?? 3000);
const dbPath = process.env.DB_PATH ?? "boilerhouse.db";
const storagePath = process.env.STORAGE_PATH ?? "./data";
const maxInstances = Number(process.env.MAX_INSTANCES ?? 100);

const db = initDatabase(dbPath);
const runtime = new FakeRuntime();
const nodeId = generateNodeId();
const activityLog = new ActivityLog(db);
const eventBus = new EventBus();

// Ensure this node exists in the database
const existingNode = db.select().from(nodes).get();
if (!existingNode) {
	db.insert(nodes)
		.values({
			nodeId,
			runtimeType: "firecracker",
			capacity: { vcpus: 8, memoryMb: 16384, diskGb: 100 },
			status: "online",
			lastHeartbeat: new Date(),
			createdAt: new Date(),
		})
		.run();
}

const instanceManager = new InstanceManager(runtime, db, activityLog, nodeId);
const snapshotManager = new SnapshotManager(runtime, db, nodeId);
const tenantDataStore = new TenantDataStore(storagePath, db);
const idleMonitor = new IdleMonitor({ defaultPollIntervalMs: 5000 });
const tenantManager = new TenantManager(
	instanceManager,
	snapshotManager,
	db,
	activityLog,
	runtime,
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

// Wire idle monitor to release tenants
idleMonitor.onIdle(async (instanceId, action) => {
	console.log(`Idle timeout: instance=${instanceId} action=${action}`);
});

// Recover state before accepting requests
const report = await recoverState(runtime, db, nodeId, activityLog);
console.log(
	`Recovery: ${report.recovered} recovered, ${report.destroyed} destroyed, ${report.orphanedTapsCleaned} orphaned TAPs cleaned`,
);

const app = createApp({
	db,
	runtime,
	nodeId,
	activityLog,
	instanceManager,
	tenantManager,
	snapshotManager,
	eventBus,
	resourceLimiter,
});

app.listen(port);

console.log(`Boilerhouse API listening on http://localhost:${port}`);
