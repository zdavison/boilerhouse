import { join } from "node:path";
import { readdirSync } from "node:fs";
import { generateNodeId } from "@boilerhouse/core";
import type { Workload } from "@boilerhouse/core";
import {
	FirecrackerRuntime,
	NetnsManagerImpl,
	JailPreparer,
	deriveNetnsConfig,
} from "@boilerhouse/runtime-firecracker";
import type {
	FirecrackerConfig,
	JailerConfig,
} from "@boilerhouse/runtime-firecracker";
import { initDatabase, ActivityLog, loadWorkloadsFromDir } from "@boilerhouse/db";
import { workloads as workloadsTable } from "@boilerhouse/db";
import { nodes } from "@boilerhouse/db";
import { InstanceManager } from "./instance-manager";
import { SnapshotManager } from "./snapshot-manager";
import { TenantManager } from "./tenant-manager";
import { TenantDataStore } from "./tenant-data";
import { IdleMonitor } from "./idle-monitor";
import { EventBus } from "./event-bus";
import { createApp } from "./app";
import { recoverState } from "./recovery";
import type { RecoveryOptions } from "./recovery";
import { ResourceLimiter } from "./resource-limits";
import { TapManager } from "./network/tap";

const port = Number(process.env.PORT ?? 3000);
const dbPath = process.env.DB_PATH ?? "boilerhouse.db";
const storagePath = process.env.STORAGE_PATH ?? "./data";
const maxInstances = Number(process.env.MAX_INSTANCES ?? 100);
const workloadsDir = process.env.WORKLOADS_DIR;
const firecrackerBinary = process.env.FIRECRACKER_BIN ?? "/usr/bin/firecracker";
const kernelPath = process.env.KERNEL_PATH ?? "/var/lib/boilerhouse/vmlinux";
const snapshotDir = process.env.SNAPSHOT_DIR ?? join(storagePath, "snapshots");
const instanceDir = process.env.INSTANCE_DIR ?? join(storagePath, "instances");
const imagesDir = process.env.IMAGES_DIR ?? join(storagePath, "images");

// Jailer configuration — enabled when JAILER_BIN is set
const jailerBin = process.env.JAILER_BIN;
const jailerChrootBase = process.env.JAILER_CHROOT_BASE ?? "/srv/jailer";
const jailerUidStart = Number(process.env.JAILER_UID_START ?? 100000);
const jailerGid = Number(process.env.JAILER_GID ?? 100000);

const useJailer = !!jailerBin;

// Build FirecrackerConfig
const runtimeConfig: FirecrackerConfig = {
	binaryPath: firecrackerBinary,
	kernelPath,
	snapshotDir,
	instanceDir,
	nodeId: undefined!, // Set after nodeId generation below
	imagesDir,
};

if (useJailer) {
	const jailerConfig: JailerConfig = {
		jailerPath: jailerBin,
		chrootBaseDir: jailerChrootBase,
		uidRangeStart: jailerUidStart,
		gid: jailerGid,
		daemonize: true,
		newPidNs: true,
		cgroupVersion: 2,
	};
	runtimeConfig.jailer = jailerConfig;
	console.log(`Jailer mode: ${jailerBin} (chroot: ${jailerChrootBase})`);
} else {
	runtimeConfig.tapManager = new TapManager();
}

const db = initDatabase(dbPath);
const nodeId = generateNodeId();
runtimeConfig.nodeId = nodeId;

const runtime = new FirecrackerRuntime(runtimeConfig);
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

// Build recovery options with cleanup callbacks
const recoveryOptions: RecoveryOptions = {};

if (useJailer) {
	const netnsManager = new NetnsManagerImpl();
	const jailPreparer = new JailPreparer();

	recoveryOptions.listNetns = () => netnsManager.list();
	recoveryOptions.destroyNetns = async (nsName) => {
		await netnsManager.destroy({
			nsName,
			nsPath: `/var/run/netns/${nsName}`,
			tapName: "tap0",
			tapIp: "",
			tapMac: "",
			vethHostIp: "",
			guestIp: "",
			vethHostName: "",
		});
	};
	recoveryOptions.deriveNsName = (id) => deriveNetnsConfig(id).nsName;
	recoveryOptions.listJails = async (chrootBaseDir) => {
		const jailsDir = join(chrootBaseDir, "firecracker");
		try {
			return readdirSync(jailsDir);
		} catch {
			return [];
		}
	};
	recoveryOptions.cleanJail = (id, chrootBaseDir) =>
		jailPreparer.cleanup(id, chrootBaseDir);
	recoveryOptions.chrootBaseDir = jailerChrootBase;
}

// Recover state before accepting requests
const report = await recoverState(runtime, db, nodeId, activityLog, recoveryOptions);

const recoverySummary = [
	`${report.recovered} recovered`,
	`${report.destroyed} destroyed`,
	`${report.orphanedTapsCleaned} orphaned TAPs`,
	`${report.orphanedNetnsCleaned} orphaned netns`,
	`${report.orphanedJailsCleaned} orphaned jails`,
].join(", ");
console.log(`Recovery: ${recoverySummary}`);

// Ensure all workloads have golden snapshots
{
	const allWorkloads = db.select().from(workloadsTable).all();
	let created = 0;
	for (const row of allWorkloads) {
		if (!snapshotManager.goldenExists(row.workloadId, nodeId)) {
			try {
				await snapshotManager.createGolden(row.workloadId, row.config as Workload);
				created++;
			} catch (err) {
				console.error(
					`Failed to create golden snapshot for ${row.name}: ${err instanceof Error ? err.message : err}`,
				);
			}
		}
	}
	if (created > 0) {
		console.log(`Golden snapshots: ${created} created`);
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
	resourceLimiter,
});

app.listen(port);

console.log(`Boilerhouse API listening on http://localhost:${port}`);
