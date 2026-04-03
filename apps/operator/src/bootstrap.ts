import { hostname } from "node:os";
import { generateNodeId } from "@boilerhouse/core";
import {
  KubernetesRuntime,
  KubeWatcher,
  KubeStatusPatcher,
  addFinalizer,
  removeFinalizer,
  FINALIZER,
  API_GROUP,
  API_VERSION,
} from "@boilerhouse/runtime-kubernetes";
import type {
  BoilerhouseWorkload,
  BoilerhouseClaim,
  BoilerhousePool,
  BoilerhouseTrigger,
  KubeClientConfig,
} from "@boilerhouse/runtime-kubernetes";
import { initDatabase, ActivityLog, nodes, claims, workloads as workloadsTable } from "@boilerhouse/db";
import { createLogger } from "@boilerhouse/o11y";
import {
  InstanceManager,
  TenantManager,
  TenantDataStore,
  PoolManager,
  IdleMonitor,
  WatchDirsPoller,
  EventBus,
  AuditLogger,
  recoverState,
} from "@boilerhouse/domain";
import { eq } from "drizzle-orm";
import type { TenantId, WorkloadId } from "@boilerhouse/core";
import { Controller } from "./controller";
import { LeaderElector } from "./leader-election";
import { reconcileWorkload } from "./workload-controller";
import { reconcilePool } from "./pool-controller";
import { reconcileClaim } from "./claim-controller";
import { reconcileTrigger } from "./trigger-controller";
import { createInternalApi } from "./internal-api";

const log = createLogger("operator");

export interface OperatorConfig {
  namespace: string;
  apiUrl: string;
  token: string;
  caCert?: string;
  storagePath: string;
  dbPath: string;
}

export function configFromEnv(): OperatorConfig {
  return {
    namespace: process.env.K8S_NAMESPACE ?? "boilerhouse",
    apiUrl: process.env.K8S_API_URL ?? "https://kubernetes.default.svc",
    token: process.env.K8S_TOKEN ?? "",
    caCert: process.env.K8S_CA_CERT,
    storagePath: process.env.STORAGE_PATH ?? "/data/storage",
    dbPath: process.env.DB_PATH ?? "/data/boilerhouse.db",
  };
}

export async function startOperator(config: OperatorConfig): Promise<void> {
  const kubeConfig: KubeClientConfig = {
    apiUrl: config.apiUrl,
    token: config.token,
    caCert: config.caCert,
  };

  // Database (ephemeral — rebuilt via recovery on leader election)
  const db = initDatabase(config.dbPath);
  const nodeId = generateNodeId();
  db.insert(nodes)
    .values({
      nodeId,
      runtimeType: "kubernetes",
      capacity: { vcpus: 0, memoryMb: 0, diskGb: 0 },
      status: "online",
      lastHeartbeat: new Date(),
      createdAt: new Date(),
    })
    .run();

  // Audit
  const activityLog = new ActivityLog(db);
  const eventBus = new EventBus();
  const audit = new AuditLogger(activityLog, eventBus, nodeId);

  // TODO: wire KubeSecretResolver into InstanceManager / TenantManager once those managers
  // accept a SecretResolver for network.credentials injection.

  // Runtime — use in-cluster auth if no token provided, otherwise external
  const runtime = config.token
    ? new KubernetesRuntime({
        auth: "external",
        apiUrl: config.apiUrl,
        token: config.token,
        caCert: config.caCert,
        namespace: config.namespace,
      })
    : new KubernetesRuntime({
        auth: "in-cluster",
        namespace: config.namespace,
      });

  // Domain managers
  const instanceManager = new InstanceManager(runtime, db, audit, nodeId);
  const tenantDataStore = new TenantDataStore(config.storagePath, db, runtime);
  const idleMonitor = new IdleMonitor({ defaultPollIntervalMs: 5000 });
  const watchDirsPoller = new WatchDirsPoller(instanceManager, idleMonitor);
  const poolManager = new PoolManager(instanceManager, runtime, db);
  const tenantManager = new TenantManager(
    instanceManager, db, audit, nodeId, tenantDataStore,
    { idleMonitor, watchDirsPoller, poolManager },
  );

  // Base API paths
  const basePath = `/apis/${API_GROUP}/${API_VERSION}`;

  // K8s status patchers — one per CRD resource
  const workloadPatcher = new KubeStatusPatcher(
    kubeConfig,
    `${API_GROUP}/${API_VERSION}/boilerhouseworkloads`,
  );
  const poolPatcher = new KubeStatusPatcher(
    kubeConfig,
    `${API_GROUP}/${API_VERSION}/boilerhousepools`,
  );
  const claimPatcher = new KubeStatusPatcher(
    kubeConfig,
    `${API_GROUP}/${API_VERSION}/boilerhouseclaims`,
  );
  const triggerPatcher = new KubeStatusPatcher(
    kubeConfig,
    `${API_GROUP}/${API_VERSION}/boilerhousetriggers`,
  );

  // Idle handler — release the claim and patch the CR status
  // Registered after claimPatcher and basePath are available.
  idleMonitor.onIdle(async (instanceId, action) => {
    log.info({ instanceId, action }, "idle timeout fired");

    try {
      // Find the claim that owns this instance
      const claimRow = db
        .select()
        .from(claims)
        .where(eq(claims.instanceId, instanceId))
        .get();

      if (!claimRow) {
        log.warn({ instanceId }, "idle fired but no claim found for instance");
        return;
      }

      const tenantId = claimRow.tenantId as TenantId;
      const workloadId = claimRow.workloadId as WorkloadId;

      // Release via TenantManager
      await tenantManager.release(tenantId, workloadId);

      // Look up workload name to find matching CR
      const workloadRow = db
        .select()
        .from(workloadsTable)
        .where(eq(workloadsTable.workloadId, workloadId))
        .get();

      if (workloadRow) {
        // List BoilerhouseClaims to find the matching CR
        const listUrl = `${config.apiUrl}${basePath}/namespaces/${config.namespace}/boilerhouseclaims`;
        const resp = await fetch(listUrl, {
          headers: config.token ? { Authorization: `Bearer ${config.token}` } : {},
        });

        if (resp.ok) {
          const list = (await resp.json()) as { items: BoilerhouseClaim[] };
          const matchingCr = list.items.find(
            (cr) =>
              cr.spec.tenantId === tenantId &&
              cr.spec.workloadRef === workloadRow.name,
          );

          if (matchingCr) {
            await claimPatcher.patchStatus(
              matchingCr.metadata.namespace ?? config.namespace,
              matchingCr.metadata.name,
              { phase: "Released" },
            );
          }
        }
      }
    } catch (err) {
      log.error({ instanceId, err }, "failed to handle idle timeout");
    }
  });

  // Controllers
  const workloadController = new Controller<BoilerhouseWorkload>({
    name: "workload",
    reconcile: async (crd) => {
      const ns = crd.metadata.namespace ?? config.namespace;
      const name = crd.metadata.name;
      // Add finalizer if not present
      if (!crd.metadata.finalizers?.includes(FINALIZER)) {
        const withFinalizer = addFinalizer(crd.metadata, FINALIZER);
        await workloadPatcher.patchMetadata(ns, name, { finalizers: withFinalizer.finalizers });
      }
      const status = await reconcileWorkload(crd, { db });
      // On deletion path: only patch status if there's an error blocking deletion
      if (!crd.metadata.deletionTimestamp || status.phase === "Error") {
        await workloadPatcher.patchStatus(ns, name, status);
      }
      // Remove finalizer after successful deletion handling
      if (crd.metadata.deletionTimestamp && status.phase !== "Error") {
        const withoutFinalizer = removeFinalizer(crd.metadata, FINALIZER);
        await workloadPatcher.patchMetadata(ns, name, { finalizers: withoutFinalizer.finalizers });
      }
    },
  });

  const poolController = new Controller<BoilerhousePool>({
    name: "pool",
    reconcile: async (crd) => {
      const ns = crd.metadata.namespace ?? config.namespace;
      const name = crd.metadata.name;
      // Add finalizer if not present
      if (!crd.metadata.finalizers?.includes(FINALIZER)) {
        const withFinalizer = addFinalizer(crd.metadata, FINALIZER);
        await poolPatcher.patchMetadata(ns, name, { finalizers: withFinalizer.finalizers });
      }
      const status = await reconcilePool(crd, { db, poolManager });
      await poolPatcher.patchStatus(ns, name, status);
      // Remove finalizer after deletion handling
      if (crd.metadata.deletionTimestamp) {
        const withoutFinalizer = removeFinalizer(crd.metadata, FINALIZER);
        await poolPatcher.patchMetadata(ns, name, { finalizers: withoutFinalizer.finalizers });
      }
    },
  });

  const claimController = new Controller<BoilerhouseClaim>({
    name: "claim",
    reconcile: async (crd) => {
      const ns = crd.metadata.namespace ?? config.namespace;
      const name = crd.metadata.name;
      // Add finalizer if not present
      if (!crd.metadata.finalizers?.includes(FINALIZER)) {
        const withFinalizer = addFinalizer(crd.metadata, FINALIZER);
        await claimPatcher.patchMetadata(ns, name, { finalizers: withFinalizer.finalizers });
      }
      // Patch Pending status for new claims before the actual reconcile
      const currentPhase = crd.status?.phase;
      if (!currentPhase) {
        await claimPatcher.patchStatus(ns, name, { phase: "Pending" });
      }
      const status = await reconcileClaim(crd, { db, tenantManager });
      await claimPatcher.patchStatus(ns, name, status);
      // Remove finalizer after release
      if (crd.metadata.deletionTimestamp) {
        const withoutFinalizer = removeFinalizer(crd.metadata, FINALIZER);
        await claimPatcher.patchMetadata(ns, name, { finalizers: withoutFinalizer.finalizers });
      }
    },
  });

  const triggerAdapters = new Map<string, { stop: () => void }>();
  const triggerController = new Controller<BoilerhouseTrigger>({
    name: "trigger",
    reconcile: async (crd) => {
      const ns = crd.metadata.namespace ?? config.namespace;
      const name = crd.metadata.name;
      // Add finalizer if not present
      if (!crd.metadata.finalizers?.includes(FINALIZER)) {
        const withFinalizer = addFinalizer(crd.metadata, FINALIZER);
        await triggerPatcher.patchMetadata(ns, name, { finalizers: withFinalizer.finalizers });
      }
      const status = await reconcileTrigger(crd, { adapters: triggerAdapters });
      // Only patch status if not being deleted (CR is going away)
      if (!crd.metadata.deletionTimestamp) {
        await triggerPatcher.patchStatus(ns, name, status);
      }
      // Remove finalizer on deletion
      if (crd.metadata.deletionTimestamp) {
        const withoutFinalizer = removeFinalizer(crd.metadata, FINALIZER);
        await triggerPatcher.patchMetadata(ns, name, { finalizers: withoutFinalizer.finalizers });
      }
    },
  });

  // KubeWatcher instances — one per CRD (created fresh; started on leader election)
  let watchers: KubeWatcher<any>[] = [];
  let controllerAbort: AbortController | null = null;

  // Internal HTTP server (health + stats endpoints) — runs on all replicas
  const internalApi = createInternalApi({ instanceManager, db });
  const apiPort = Number(process.env.INTERNAL_API_PORT ?? 9090);
  Bun.serve({ fetch: internalApi.fetch, port: apiPort });
  log.info({ port: apiPort }, "internal API server listening");

  // Leader election
  const elector = new LeaderElector({
    leaseName: "boilerhouse-operator-leader",
    leaseNamespace: config.namespace,
    identity: hostname(),
    leaseDurationSeconds: 15,
    renewDeadlineSeconds: 10,
    retryPeriodSeconds: 2,
    apiUrl: config.apiUrl,
    headers: config.token ? { Authorization: `Bearer ${config.token}` } : {},
    caCert: config.caCert,
    onStartedLeading: async () => {
      log.info("became leader, starting recovery and controllers");
      // Recovery only runs on the leader — rebuilds in-memory state from K8s
      await recoverState(runtime, db, nodeId, audit);
      log.info("recovery complete");

      controllerAbort = new AbortController();
      const signal = controllerAbort.signal;

      // Create and start one KubeWatcher per CRD
      const workloadWatcher = new KubeWatcher<BoilerhouseWorkload>(kubeConfig, {
        path: `${basePath}/boilerhouseworkloads`,
        namespace: config.namespace,
        onEvent: (e) => {
          if (e.type !== "BOOKMARK" && e.type !== "DELETED") workloadController.enqueue(e.object);
        },
      });

      const poolWatcher = new KubeWatcher<BoilerhousePool>(kubeConfig, {
        path: `${basePath}/boilerhousepools`,
        namespace: config.namespace,
        onEvent: (e) => {
          if (e.type !== "BOOKMARK" && e.type !== "DELETED") poolController.enqueue(e.object);
        },
      });

      const claimWatcher = new KubeWatcher<BoilerhouseClaim>(kubeConfig, {
        path: `${basePath}/boilerhouseclaims`,
        namespace: config.namespace,
        onEvent: (e) => {
          if (e.type !== "BOOKMARK" && e.type !== "DELETED") claimController.enqueue(e.object);
        },
      });

      const triggerWatcher = new KubeWatcher<BoilerhouseTrigger>(kubeConfig, {
        path: `${basePath}/boilerhousetriggers`,
        namespace: config.namespace,
        onEvent: (e) => {
          if (e.type !== "BOOKMARK" && e.type !== "DELETED") triggerController.enqueue(e.object);
        },
      });

      watchers = [workloadWatcher, poolWatcher, claimWatcher, triggerWatcher];
      for (const w of watchers) w.start();

      // Start controller loops (non-blocking — they run until signal aborts)
      void workloadController.start(signal);
      void poolController.start(signal);
      void claimController.start(signal);
      void triggerController.start(signal);
    },
    onStoppedLeading: () => {
      log.warn("lost leadership, stopping controllers");
      for (const w of watchers) w.stop();
      watchers = [];
      workloadController.stop();
      poolController.stop();
      claimController.stop();
      triggerController.stop();
      controllerAbort?.abort();
      controllerAbort = null;
    },
  });

  await elector.start();
}
