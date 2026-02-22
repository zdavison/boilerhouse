import { join } from "node:path";
import { readdirSync } from "node:fs";
import { eq } from "drizzle-orm";
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
import { workloads as workloadsTable, tenants } from "@boilerhouse/db";
import { nodes } from "@boilerhouse/db";
import { InstanceManager } from "./instance-manager";
import { SnapshotManager } from "./snapshot-manager";
import { TenantManager } from "./tenant-manager";
import { TenantDataStore } from "./tenant-data";
import { IdleMonitor } from "./idle-monitor";
import { EventBus } from "./event-bus";
import { GoldenCreator } from "./golden-creator";
import { OciImageBuilder } from "./image-builder";
import { createApp } from "./app";
import { recoverState } from "./recovery";
import type { RecoveryOptions } from "./recovery";
import { ResourceLimiter } from "./resource-limits";
import { TapManager } from "./network/tap";
import { applyWorkloadTransition, forceWorkloadStatus } from "./transitions";

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
const guestInitDir = process.env.GUEST_INIT_DIR ?? join(import.meta.dir, "../../../packages/guest-init");

// Jailer configuration — enabled when JAILER_BIN is set
const jailerBin = process.env.JAILER_BIN;
const jailerChrootBase = process.env.JAILER_CHROOT_BASE ?? "/srv/jailer";
const jailerUidStart = Number(process.env.JAILER_UID_START ?? 100000);
const jailerGid = Number(process.env.JAILER_GID ?? 100000);

const useJailer = !!jailerBin;

const db = initDatabase(dbPath);
const existingNode = db.select().from(nodes).get();
const nodeId = existingNode ? existingNode.nodeId : generateNodeId();

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

const runtimeConfig: FirecrackerConfig = {
	binaryPath: firecrackerBinary,
	kernelPath,
	snapshotDir,
	instanceDir,
	nodeId,
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

const runtime = new FirecrackerRuntime(runtimeConfig);
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

// Build recovery options with cleanup callbacks
const recoveryOptions: RecoveryOptions = {};
const tapManager = useJailer ? null : (runtimeConfig.tapManager as TapManager);

if (!useJailer && tapManager) {
	recoveryOptions.listTaps = async () => {
		const proc = Bun.spawn(["ip", "-o", "link", "show", "type", "tuntap"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const output = await new Response(proc.stdout).text();
		await proc.exited;
		// Each line: "N: tap-XXXXXXXX: ..."
		return output
			.split("\n")
			.map((line) => line.match(/^\d+:\s+(tap-[0-9a-f]+)/)?.[1])
			.filter((name): name is string => !!name);
	};
	recoveryOptions.destroyTap = async (tapName) => {
		await tapManager.destroy({ name: tapName, ip: "", mac: "" });
	};
}

if (useJailer) {
	const netnsManager = new NetnsManagerImpl();
	const jailPreparer = new JailPreparer();

	recoveryOptions.listNetns = () => netnsManager.list();
	recoveryOptions.destroyNetns = (nsName) => netnsManager.destroyByName(nsName);
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
	`${report.tenantsReset} tenants reset`,
	`${report.orphanedTapsCleaned} orphaned TAPs`,
	`${report.orphanedNetnsCleaned} orphaned netns`,
	`${report.orphanedJailsCleaned} orphaned jails`,
].join(", ");
console.log(`Recovery: ${recoverySummary}`);

const imageBuilder = new OciImageBuilder(imagesDir, {
	workloadsDir,
	initConfig: {
		initBinaryPath: join(guestInitDir, "build/x86_64/init"),
		idleAgentPath: join(guestInitDir, "build/x86_64/idle-agent"),
		overlayInitPath: join(guestInitDir, "overlay-init.sh"),
	},
});
const goldenCreator = new GoldenCreator(db, snapshotManager, eventBus, imageBuilder);

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
	resourceLimiter,
});

app.listen(port);

console.log(`Boilerhouse API listening on http://localhost:${port}`);
