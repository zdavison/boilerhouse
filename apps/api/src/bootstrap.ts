import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { eq } from "drizzle-orm";
import { FakeRuntime, generateNodeId } from "@boilerhouse/core";
import type { Runtime, RuntimeType, NodeId } from "@boilerhouse/core";
import { DockerRuntime } from "@boilerhouse/runtime-docker";
import { initDatabase, ActivityLog, loadWorkloadsFromDir, loadTriggersFromDir, workloads as workloadsTable } from "@boilerhouse/db";
import { claims } from "@boilerhouse/db";
import { nodes } from "@boilerhouse/db";
import type { DrizzleDb } from "@boilerhouse/db";
import {
	createLogger,
	initO11y,
	instrumentFromEventBus,
	wrapTenantManager,
	wrapInstanceManager,
} from "@boilerhouse/o11y";
import {
	InstanceManager,
	TenantManager,
	TenantDataStore,
	IdleMonitor,
	WatchDirsPoller,
	EventBus,
	AuditLogger,
	BootstrapLogStore,
	PoolManager,
	recoverState,
} from "@boilerhouse/domain";
import { createApp } from "./app";
import { ResourceLimiter } from "./resource-limits";
import { SecretStore } from "./secret-store";
import { buildProxyCreateOptions } from "./proxy/config";
import { prewarmPools } from "./startup-prewarm";
import { ContainerStatsPoller } from "./container-stats-poller";
import { WorkloadWatcher } from "./workload-watcher";
import { createBlobStore } from "@boilerhouse/storage";

// ── Config ──────────────────────────────────────────────────────────────────

export interface S3Config {
	bucket?: string;
	region?: string;
	endpoint?: string;
	accessKeyId?: string;
	secretAccessKey?: string;
}

export interface K8sConfig {
	apiUrl?: string;
	token?: string;
	caCert?: string;
	namespace?: string;
	context?: string;
	minikubeProfile?: string;
}

export interface BootstrapConfig {
	port: number;
	listenHost: string;
	dbPath: string;
	storagePath: string;
	runtimeType: RuntimeType;
	maxInstances: number;
	workloadsDir?: string;
	apiKey?: string;
	secretKey?: string;
	metricsPort: number;
	metricsHost: string;
	/** Docker-specific */
	dockerSocket?: string;
	seccompProfilePath?: string;
	/** S3 blob storage. Omit or set enabled=false for local-only disk storage. */
	s3?: S3Config;
	/** Local overlay cache */
	overlayCacheDir: string;
	overlayCacheMaxBytes: number;
	/** Kubernetes-specific */
	k8s?: K8sConfig;
}

/** Reads configuration from environment variables with defaults. */
export function configFromEnv(): BootstrapConfig {
	return {
		port: Number(process.env.PORT ?? 3000),
		listenHost: process.env.LISTEN_HOST ?? "127.0.0.1",
		dbPath: process.env.DB_PATH ?? "boilerhouse.db",
		storagePath: resolve(process.env.STORAGE_PATH ?? "./data"),
		runtimeType: (process.env.RUNTIME_TYPE ?? "docker") as RuntimeType,
		maxInstances: Number(process.env.MAX_INSTANCES ?? 100),
		workloadsDir: process.env.WORKLOADS_DIR,
		apiKey: process.env.BOILERHOUSE_API_KEY || undefined,
		secretKey: process.env.BOILERHOUSE_SECRET_KEY,
		metricsPort: Number(process.env.METRICS_PORT ?? 9464),
		metricsHost: process.env.METRICS_HOST ?? "127.0.0.1",
		s3: process.env.S3_ENABLED === "true"
			? {
				bucket: process.env.S3_BUCKET,
				region: process.env.S3_REGION,
				endpoint: process.env.S3_ENDPOINT,
				accessKeyId: process.env.AWS_ACCESS_KEY_ID,
				secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
			}
			: undefined,
		overlayCacheDir: process.env.OVERLAY_CACHE_DIR ?? "./data/cache/overlays",
		overlayCacheMaxBytes: Number(process.env.OVERLAY_CACHE_MAX_BYTES ?? 10737418240),
		dockerSocket: process.env.DOCKER_SOCKET,
		seccompProfilePath: process.env.SECCOMP_PROFILE_PATH,
		k8s: {
			apiUrl: process.env.K8S_API_URL,
			token: process.env.K8S_TOKEN,
			caCert: process.env.K8S_CA_CERT,
			namespace: process.env.K8S_NAMESPACE,
			context: process.env.K8S_CONTEXT,
			minikubeProfile: process.env.K8S_MINIKUBE_PROFILE,
		},
	};
}

// ── Context ─────────────────────────────────────────────────────────────────

export interface AppContext {
	app: ReturnType<typeof createApp>;
	db: DrizzleDb;
	runtime: Runtime;
	nodeId: NodeId;
	eventBus: EventBus;
	instanceManager: InstanceManager;
	tenantManager: TenantManager;
	poolManager: PoolManager;
	idleMonitor: IdleMonitor;
	config: BootstrapConfig;
}

// ── Bootstrap ───────────────────────────────────────────────────────────────

export async function bootstrap(config: BootstrapConfig): Promise<AppContext> {
	const log = createLogger("server");

	mkdirSync(config.storagePath, { recursive: true });
	mkdirSync(join(config.storagePath, "sidecar"), { recursive: true });

	const db = initDatabase(config.dbPath);
	const existingNode = db.select().from(nodes).get();
	const nodeId = existingNode ? existingNode.nodeId : generateNodeId();

	if (!existingNode) {
		db.insert(nodes)
			.values({
				nodeId,
				runtimeType: config.runtimeType,
				capacity: { vcpus: 8, memoryMb: 16384, diskGb: 100 },
				status: "online",
				lastHeartbeat: new Date(),
				createdAt: new Date(),
			})
			.run();
	}

	const activityLog = new ActivityLog(db);
	const eventBus = new EventBus();
	const audit = new AuditLogger(activityLog, eventBus, nodeId);

	if (config.apiKey) {
		log.info("API authentication enabled (BOILERHOUSE_API_KEY is set)");
	} else {
		log.warn("API authentication disabled — set BOILERHOUSE_API_KEY to require auth");
	}

	if (!config.secretKey && process.env.NODE_ENV !== "test") {
		log.fatal("BOILERHOUSE_SECRET_KEY is required. Set it to a hex-encoded 32-byte key.");
		process.exit(1);
	}

	const secretStore = config.secretKey ? new SecretStore(db, config.secretKey) : undefined;
	if (secretStore) {
		log.info("Secret store initialised.");
	}

	// ── Blob stores (S3 + LRU disk cache, or disk-only) ─────────────────
	const blobStoreConfig = {
		cacheDir: config.overlayCacheDir,
		cacheMaxBytes: config.overlayCacheMaxBytes,
		s3Enabled: !!config.s3,
		s3Bucket: config.s3?.bucket,
		s3Region: config.s3?.region,
		s3Endpoint: config.s3?.endpoint,
		s3AccessKeyId: config.s3?.accessKeyId,
		s3SecretAccessKey: config.s3?.secretAccessKey,
		s3Prefix: "overlays/",
		s3ForcePathStyle: !!config.s3?.endpoint,
	};
	const overlayStore = createBlobStore(blobStoreConfig);
	const encryptedOverlayStore = config.secretKey
		? createBlobStore({ ...blobStoreConfig, encryptionKey: config.secretKey })
		: undefined;

	log.info({ s3Enabled: !!config.s3 }, "Overlay blob store initialised");

	const runtime = await createRuntime(config, log);

	if (config.workloadsDir) {
		const result = await loadWorkloadsFromDir(db, config.workloadsDir);
		log.info(
			{ loaded: result.loaded, updated: result.updated, unchanged: result.unchanged, errors: result.errors.length },
			"Workloads loaded from disk",
		);
		for (const { file, error } of result.errors) {
			log.error({ file, error }, "Failed to load workload");
		}

		const triggerResult = await loadTriggersFromDir(db, config.workloadsDir);
		log.info(
			{ loaded: triggerResult.loaded, updated: triggerResult.updated, unchanged: triggerResult.unchanged, errors: triggerResult.errors.length },
			"Triggers loaded from disk",
		);
		for (const { file, error } of triggerResult.errors) {
			log.error({ file, error }, "Failed to load trigger");
		}
	}

	const proxyConfigBuilder = secretStore
		? (workload: Parameters<typeof buildProxyCreateOptions>[0], tenantId?: Parameters<typeof buildProxyCreateOptions>[2]) =>
			buildProxyCreateOptions(workload, secretStore, tenantId)
		: undefined;

	const instanceManager = new InstanceManager(
		runtime, db, audit, nodeId,
		createLogger("InstanceManager"),
		proxyConfigBuilder,
	);
	const tenantDataStore = new TenantDataStore(config.storagePath, db, runtime, {
		blobStore: overlayStore,
		encryptedBlobStore: encryptedOverlayStore,
	});
	const idleMonitor = new IdleMonitor({ defaultPollIntervalMs: 5000, log: createLogger("IdleMonitor") });
	const watchDirsPoller = new WatchDirsPoller(instanceManager, idleMonitor);
	const bootstrapLogStore = new BootstrapLogStore(db);

	const poolManager = new PoolManager(instanceManager, runtime, db, {
		bootstrapLogStore,
		audit,
	});

	const tenantManager = new TenantManager(
		instanceManager,
		db,
		audit,
		nodeId,
		tenantDataStore,
		{
			idleMonitor,
			log: createLogger("TenantManager"),
			watchDirsPoller,
			poolManager,
		},
	);

	const resourceLimiter = new ResourceLimiter(db, { maxInstances: config.maxInstances });

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

		audit.idleTimeout(instanceId, claimRow.tenantId, action);
		log.info({ instanceId, tenantId: claimRow.tenantId, action }, "Idle timeout: releasing tenant");
		try {
			await tenantManager.release(claimRow.tenantId, claimRow.workloadId);
		} catch (err) {
			log.error({ instanceId, tenantId: claimRow.tenantId, err }, "Idle timeout: release failed");
			throw err;
		}
	});

	const report = await recoverState(runtime, db, nodeId, audit);
	log.info(
		{ recovered: report.recovered, destroyed: report.destroyed, claimsReset: report.claimsReset },
		"Recovery complete",
	);

	prewarmPools(db, poolManager);

	if (config.workloadsDir) {
		const watcher = new WorkloadWatcher(db, config.workloadsDir, {
			onNew: async (workloadId) => {
				poolManager.prime(workloadId).catch((err: unknown) => {
					const message = err instanceof Error ? err.message : String(err);
					db.update(workloadsTable)
						.set({ status: "error", statusDetail: message, updatedAt: new Date() })
						.where(eq(workloadsTable.workloadId, workloadId))
						.run();
				});
			},
			onUpdated: async (workloadId) => {
				poolManager.prime(workloadId, { drainExisting: true }).catch((err: unknown) => {
					const message = err instanceof Error ? err.message : String(err);
					db.update(workloadsTable)
						.set({ status: "error", statusDetail: message, updatedAt: new Date() })
						.where(eq(workloadsTable.workloadId, workloadId))
						.run();
				});
			},
			pollIntervalMs: 5000,
		});
		watcher.start();
		log.info({ dir: config.workloadsDir, pollIntervalMs: 5000 }, "Workload file watcher started");
	}

	const { meter, tracer } = initO11y({
		metricsPort: config.metricsPort,
		metricsHost: config.metricsHost,
	});

	const containerStatsPoller = new ContainerStatsPoller(runtime, db);
	containerStatsPoller.start();

	instrumentFromEventBus(meter, {
		eventBus,
		db,
		nodeId,
		maxInstances: config.maxInstances,
		resourceLimiter,
		poolManager,
		containerStatsProvider: containerStatsPoller,
		overlayCacheDir: config.overlayCacheDir,
	});

	const tracedTenantManager = wrapTenantManager(tenantManager, tracer);
	const tracedInstanceManager = wrapInstanceManager(instanceManager, tracer);

	const app = createApp({
		db,
		runtime,
		nodeId,
		activityLog,
		apiKey: config.apiKey,
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

	return {
		app,
		db,
		runtime,
		nodeId,
		eventBus,
		instanceManager,
		tenantManager,
		poolManager,
		idleMonitor,
		config,
	};
}

// ── Runtime factory ─────────────────────────────────────────────────────────

async function createRuntime(
	config: BootstrapConfig,
	log: ReturnType<typeof createLogger>,
): Promise<Runtime> {
	if (config.runtimeType === "docker") {
		log.info({ socketPath: config.dockerSocket ?? "/var/run/docker.sock" }, "Using Docker runtime");
		return new DockerRuntime({
			socketPath: config.dockerSocket,
			seccompProfilePath: config.seccompProfilePath,
			sidecarTmpDir: join(config.storagePath, "sidecar"),
			endpointHost: process.env.DOCKER_HOST_ADDRESS ?? "127.0.0.1",
		});
	}

	return new FakeRuntime();
}
