# Kubernetes Runtime Plan

## Context

Boilerhouse currently supports two runtimes: `PodmanRuntime` (production, with CRIU
checkpoint/restore) and `FakeRuntime` (testing). Both implement the `Runtime` interface
in `packages/core/src/runtime.ts`.

We want to add a `KubernetesRuntime` so that agents can run as native K8s pods — no
podman, no boilerhouse-podmand, no CRIU required. Users who only want K8s can completely
ignore the podman stack. Checkpoint/restore is not available in this mode; agents cold
boot every time but tenant state is preserved via snapshot archives of overlay data.

This requires three prerequisite changes:
1. **Rename `boilerhoused` → `boilerhouse-podmand`** — the daemon is podman-specific, not
   a generic runtime daemon. The current name implies it's required for all runtimes.
2. The `Runtime` interface must expose **capabilities** so that managers can branch on
   whether CRIU checkpoint/restore is supported.
3. A **TenantDataStore** abstraction to archive and restore tenant overlay data on
   release/claim, replacing the CRIU-based hibernate/restore path.

## Prerequisite: Rename boilerhoused → boilerhouse-podmand

### Rationale

`boilerhoused` is a podman-specific daemon — it manages a podman subprocess, owns HMAC
keys for CRIU checkpoint archives, and exposes podman operations over a Unix socket. None
of this applies to the Kubernetes runtime. The generic-sounding name creates confusion
about whether it's required for all runtimes. Renaming it to `boilerhouse-podmand` makes
the scope explicit.

### Rename scope

The project is NOT-RELEASED — no backwards compatibility or migration needed.

#### Directory + file renames

| Before                                  | After                                       |
|-----------------------------------------|---------------------------------------------|
| `apps/boilerhoused/`                    | `apps/boilerhouse-podmand/`                 |
| `deploy/boilerhoused.service`           | `deploy/boilerhouse-podmand.service`        |
| `scripts/setup-boilerhoused.sh`         | `scripts/setup-boilerhouse-podmand.sh`      |
| `scripts/start-boilerhoused.sh`         | `scripts/start-boilerhouse-podmand.sh`      |

#### Package name

`apps/boilerhouse-podmand/package.json`: `"name": "@boilerhouse/boilerhouse-podmand"`

#### Source code string references (~80 occurrences across ~24 files)

Bulk find-and-replace `boilerhoused` → `boilerhouse-podmand` in:

| Category           | Files                                                                                    |
|--------------------|------------------------------------------------------------------------------------------|
| Daemon source      | `apps/boilerhouse-podmand/src/main.ts`, `validate.ts`, `validate.test.ts`, `main.test.ts` |
| Runtime-podman     | `packages/runtime-podman/src/daemon-backend.ts`, `daemon-backend.test.ts`, `types.ts`, `runtime.test.ts` |
| Core               | `packages/core/src/paths.ts`                                                             |
| API server         | `apps/api/src/server.ts`                                                                 |
| Kadai actions      | `.kadai/actions/daemon.sh`, `.kadai/actions/containers.sh`                               |
| Systemd            | `deploy/boilerhouse-podmand.service`                                                     |
| Scripts            | `scripts/setup-boilerhouse-podmand.sh`, `scripts/start-boilerhouse-podmand.sh`           |
| Docs               | `README.md`, plan docs in `docs/plans/`                                                  |

#### Container labels

`apps/boilerhouse-podmand/src/validate.ts`: `"managed-by": "boilerhouse-podmand"`

This also affects `validate.test.ts` assertions.

#### bun.lock

Regenerated automatically by `bun install` after the package.json rename.

## Prerequisite: Runtime Capabilities

### Problem

The `TenantManager.claim()` method (line 57–129 of `apps/api/src/tenant-manager.ts`)
follows a 4-step restore hierarchy that assumes CRIU checkpoint/restore always works:

1. Existing active instance
2. Tenant snapshot (hot restore)
3. Golden + data overlay
4. Golden snapshot (fresh restore)

Steps 2–4 all call `instanceManager.restoreFromSnapshot()`. On a K8s runtime, these would
all fail. Similarly, `TenantManager.release()` calls `instanceManager.hibernate()` when
`idleAction === "hibernate"`, which calls `runtime.snapshot()`.

The `GoldenCreator` (line 66–114 of `apps/api/src/golden-creator.ts`) calls
`snapshotManager.createGolden()` for every new workload — this would also fail on K8s.

### Solution

Add a `capabilities` property to the `Runtime` interface. Only CRIU support varies
between runtimes — `exec` and `logs` are already optional methods on the interface and
don't need to be duplicated in capabilities:

```typescript
// packages/core/src/runtime.ts

interface RuntimeCapabilities {
  /** Whether CRIU checkpoint/restore is supported. */
  criu: boolean;
}

interface Runtime {
  readonly capabilities: RuntimeCapabilities;
  // ... existing methods unchanged
}
```

Add a typed error for when unsupported operations are called:

```typescript
class RuntimeCapabilityError extends Error {
  constructor(operation: string, runtime: string) {
    super(`${operation} is not supported by the ${runtime} runtime`);
    this.name = "RuntimeCapabilityError";
  }
}
```

### Files to modify

| File                                       | Change                                                                  |
|--------------------------------------------|-------------------------------------------------------------------------|
| `packages/core/src/runtime.ts`             | Add `RuntimeCapabilities`, `RuntimeCapabilityError`, `capabilities` field |
| `packages/core/src/index.ts`               | Export new types                                                        |
| `packages/core/src/fake-runtime.ts`        | Add `capabilities: { criu: true }`                                      |
| `packages/runtime-podman/src/runtime.ts`   | Add `capabilities: { criu: true }`                                      |

## Prerequisite: TenantDataStore

### Problem

Without CRIU, we can't checkpoint/restore process memory — but tenant data in overlay
directories (`filesystem.overlay_dirs` from the workload spec) still needs to persist
across release/claim cycles. A tenant should be able to release, have their pod destroyed,
and on re-claim get a fresh pod with their previous overlay data restored.

### Solution

Introduce a `TenantDataStore` interface that archives and restores overlay directory
contents per tenant:

```typescript
// packages/core/src/tenant-data-store.ts

interface TenantDataStore {
  /**
   * Archive overlay dirs from a running instance for later restoration.
   * Called during release() before the instance is destroyed.
   */
  save(tenantId: TenantId, workloadId: WorkloadId, handle: InstanceHandle): Promise<void>;

  /**
   * Restore previously archived overlay data into a running instance.
   * Called during claim() after a fresh instance is created.
   * Returns false if no snapshot exists for this tenant+workload.
   */
  restore(tenantId: TenantId, workloadId: WorkloadId, handle: InstanceHandle): Promise<boolean>;

  /** Delete all archived data for a tenant. */
  delete(tenantId: TenantId): Promise<void>;

  /** Check if a snapshot exists for the given tenant+workload pair. */
  exists(tenantId: TenantId, workloadId: WorkloadId): Promise<boolean>;
}
```

### Implementations

**`LocalTenantDataStore`** (works for both Podman-without-CRIU and local dev):
- `save()`: exec into the container, tar the overlay dirs, write to
  `{snapshotDir}/tenants/{tenantId}/{workloadId}.tar.gz`
- `restore()`: copy the tar into the new container, exec to extract it
- Uses `runtime.exec()` — available on all runtimes

**`K8sTenantDataStore`** (Kubernetes-native):
- Uses a PersistentVolumeClaim per tenant, or a shared PVC with per-tenant subdirectories
- `save()`: run an init-style pod that copies overlay data from the instance pod to the PVC
- `restore()`: mount the PVC subdirectory into the new pod as an init container that
  copies data into the overlay dirs before the main container starts
- Alternative (simpler, NOT-RELEASED): tar to a hostPath volume, same as local

For NOT-RELEASED, `LocalTenantDataStore` is sufficient for all runtimes. The K8s-native
version can be added later when multi-node K8s support matters.

### Files to add/modify

| File                                        | Change                                         |
|---------------------------------------------|-------------------------------------------------|
| `packages/core/src/tenant-data-store.ts`    | New: `TenantDataStore` interface                |
| `packages/core/src/index.ts`                | Export `TenantDataStore`                        |
| `packages/core/src/local-tenant-data.ts`    | New: `LocalTenantDataStore` implementation      |
| `apps/api/src/routes/deps.ts`               | Add `tenantDataStore` to `RouteDeps`            |
| `apps/api/src/server.ts`                    | Instantiate and wire `LocalTenantDataStore`     |

## Manager Changes

### TenantManager

`apps/api/src/tenant-manager.ts`:

- Constructor gains `TenantDataStore` and access to `RuntimeCapabilities`
- `claim()`:
  - When `capabilities.criu === true`: existing 4-step CRIU restore hierarchy (unchanged)
  - When `capabilities.criu === false`:
    1. Check for existing active instance (unchanged)
    2. Cold boot via `instanceManager.create(workloadId, workload, tenantId)`
    3. Call `tenantDataStore.restore(tenantId, workloadId, handle)` to restore overlay data
    4. Add `"snapshot"` to the `ClaimSource` type (tenant had archived data) and `"cold"`
       (no prior data, first claim)
- `release()`:
  - When `capabilities.criu === true`: existing CRIU hibernate path (unchanged)
  - When `capabilities.criu === false`:
    1. Call `tenantDataStore.save(tenantId, workloadId, handle)` to archive overlay data
    2. Destroy the instance (regardless of `idleAction`)

### GoldenCreator

`apps/api/src/golden-creator.ts`:

- `processItem()`: when `capabilities.criu === false`, skip `snapshotManager.createGolden()`
  and immediately transition workload to "ready". The workload is usable without a golden
  snapshot — it just cold boots every time.

### Server startup

`apps/api/src/server.ts`:

- Golden snapshot enqueue loop (lines 179–198): skip enqueue when
  `runtime.capabilities.criu === false`. Instead, mark workloads as "ready" directly.
- Add `"kubernetes"` case to runtime instantiation switch.

## RuntimeType Expansion

`packages/core/src/node.ts`:

```typescript
// Before
export const RuntimeTypeSchema = Type.Union([
  Type.Literal("podman"),
  Type.Literal("vz"),
]);
export const RUNTIME_TYPES = ["podman", "vz"] as const;

// After
export const RuntimeTypeSchema = Type.Union([
  Type.Literal("podman"),
  Type.Literal("vz"),
  Type.Literal("kubernetes"),
]);
export const RUNTIME_TYPES = ["podman", "vz", "kubernetes"] as const;
```

No DB migration needed — `runtime_type` is a text column and the project is NOT-RELEASED.

## KubernetesRuntime Package

### Structure

```
packages/runtime-kubernetes/
  package.json          @boilerhouse/runtime-kubernetes
  tsconfig.json
  src/
    index.ts            re-exports
    runtime.ts          KubernetesRuntime implements Runtime
    client.ts           minimal K8s API client (raw fetch)
    translator.ts       Workload → K8s Pod/Service spec
    types.ts            KubernetesConfig
    runtime.test.ts
    translator.test.ts
    client.test.ts
```

Dependencies: `@boilerhouse/core: "workspace:*"` only. No `@kubernetes/client-node` —
use raw `fetch()` against the K8s REST API to avoid 30+ transitive dependencies and
ensure Bun compatibility.

### Authentication

Support two modes (sufficient for NOT-RELEASED):

1. **In-cluster**: read service account token from
   `/var/run/secrets/kubernetes.io/serviceaccount/token` and CA cert from
   `/var/run/secrets/kubernetes.io/serviceaccount/ca.crt`
2. **Explicit**: `KUBERNETES_API_URL` + `KUBERNETES_TOKEN` env vars

### KubernetesConfig

```typescript
interface KubernetesConfig {
  /** K8s API server URL. @example "https://10.0.0.1:6443" */
  apiUrl: string;
  /** Bearer token for authentication. */
  token: string;
  /** CA cert for TLS (PEM). Optional — skips verification if omitted. */
  caCert?: string;
  /** Namespace for boilerhouse-managed pods. @default "boilerhouse" */
  namespace?: string;
  /** Label prefix. @default "boilerhouse.dev" */
  labelPrefix?: string;
}
```

### Runtime Method Mapping

| Method                        | K8s implementation                                                                                                                                                               |
|-------------------------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `create(workload, instanceId)` | POST pod spec + optional ClusterIP Service for exposed ports. Labels: `boilerhouse.dev/managed=true`, `boilerhouse.dev/instance-id={id}`, `boilerhouse.dev/workload-id={id}`    |
| `start(handle)`               | Poll until pod phase = `Running`. No-op if already running.                                                                                                                      |
| `destroy(handle)`             | DELETE pod + DELETE service (if exists). `gracePeriodSeconds: 0`                                                                                                                 |
| `snapshot(handle)`            | Throw `RuntimeCapabilityError("snapshot", "kubernetes")`                                                                                                                         |
| `restore(ref, instanceId)`    | Throw `RuntimeCapabilityError("restore", "kubernetes")`                                                                                                                          |
| `exec(handle, command)`       | WebSocket exec API (`/api/v1/namespaces/{ns}/pods/{name}/exec`). Bun has native WebSocket.                                                                                       |
| `getEndpoint(handle)`         | GET pod → `status.podIP` + container ports. If Service exists, use Service ClusterIP.                                                                                            |
| `list()`                      | GET pods with label selector `boilerhouse.dev/managed=true` → extract instance IDs from labels                                                                                   |
| `available()`                 | GET `/api/v1/namespaces/{ns}` → 200 means available                                                                                                                             |
| `getContainerIp(handle)`      | GET pod → `status.podIP`                                                                                                                                                         |
| `logs(handle, tail?)`         | GET `/api/v1/namespaces/{ns}/pods/{name}/log?tailLines={tail}`                                                                                                                   |
| `capabilities`                | `{ criu: false }`                                                                                                                                                                |

### Workload → Pod Spec Translation

`translator.ts` — pure function `workloadToPodSpec()`:

| Workload field              | K8s Pod spec field                                                               |
|-----------------------------|----------------------------------------------------------------------------------|
| `image.ref`                 | `containers[0].image`                                                            |
| `resources.vcpus`           | `resources.requests.cpu` + `limits.cpu` (millicores: `vcpus * 1000 + "m"`)       |
| `resources.memory_mb`       | `resources.requests.memory` + `limits.memory` (`"{memory_mb}Mi"`)                |
| `network.access: "none"`    | `dnsPolicy: "None"`, `dnsConfig: {}`, no Service created                         |
| `network.access: "outbound"` | Default DNS, no Service                                                         |
| `network.access: "restricted"` | `NetworkPolicy` limiting egress to allowlisted domains (future)               |
| `network.expose[].guest`    | `containers[0].ports[].containerPort` + ClusterIP Service                        |
| `entrypoint.cmd`            | `containers[0].command`                                                          |
| `entrypoint.args`           | `containers[0].args`                                                             |
| `entrypoint.env`            | `containers[0].env` (name/value pairs)                                           |
| `entrypoint.workdir`        | `containers[0].workingDir`                                                       |
| `health.http_get`           | `readinessProbe.httpGet: { path, port }`                                         |
| `health.exec`               | `readinessProbe.exec: { command }`                                               |
| `filesystem.overlay_dirs`   | `emptyDir` volumes + `volumeMounts` at those paths                               |

Fields that don't translate directly:
- `network.credentials` — handled by proxy layer, not the runtime
- `disk_gb` — could map to `ephemeral-storage` resource limit
- `image.dockerfile` — requires a build step (out of scope, same as podman)

### Server Wiring

In `apps/api/src/server.ts`, add after the podman case:

```typescript
} else if (runtimeType === "kubernetes") {
  const { KubernetesRuntime } = await import("@boilerhouse/runtime-kubernetes");
  runtime = new KubernetesRuntime({
    apiUrl: process.env.KUBERNETES_API_URL ?? "https://kubernetes.default.svc",
    token: process.env.KUBERNETES_TOKEN ?? readInClusterToken(),
    caCert: process.env.KUBERNETES_CA_CERT,
    namespace: process.env.KUBERNETES_NAMESPACE ?? "boilerhouse",
  });
}
```

## Testing

Testing follows the same three-tier pattern as the Podman runtime: unit tests (no
dependencies), integration tests (real cluster via minikube), and E2E tests (full API
server against all detected runtimes).

### Unit tests (no cluster needed)

Run with `bun test packages/runtime-kubernetes/src/`.

**`translator.test.ts`**: Pure tests for each workload field mapping. Edge cases: no ports,
no entrypoint, various network modes, overlay dirs.

**`client.test.ts`**: Mock HTTP server on a temp Unix socket (same pattern as
`packages/runtime-podman/src/client.test.ts`). Test each K8s API call: create pod, delete
pod, list pods, exec, logs.

**`runtime.test.ts`**: Full lifecycle against mock K8s API. Verify:
- `create()` → sends correct pod spec, waits for Running phase
- `start()` → polls status
- `destroy()` → sends DELETE with gracePeriodSeconds=0
- `snapshot()` → throws `RuntimeCapabilityError`
- `restore()` → throws `RuntimeCapabilityError`
- `exec()` → sends WebSocket exec request
- `list()` → returns instance IDs from pod labels

**`local-tenant-data.test.ts`**: Test `LocalTenantDataStore`:
- `save()` + `restore()` round-trip preserves overlay data
- `restore()` returns false when no snapshot exists
- `delete()` removes all data for a tenant
- `exists()` correctly reports presence/absence

**Manager capability tests** (in `apps/api/src/`):
- `TenantManager.claim()` with `criu: false` → cold boots, restores overlay data
- `TenantManager.claim()` with `criu: false` + no prior snapshot → cold boots, no restore
- `TenantManager.release()` with `criu: false` → archives overlay data, then destroys
- `GoldenCreator` with `criu: false` → marks workload ready without golden snapshot

### Integration tests (requires minikube)

Mirrors the Podman integration test pattern in
`packages/runtime-podman/src/runtime.integration.test.ts`: detect the cluster at the top
of the file with a two-step probe, then `describe.skipIf(!k8sAvailable)` the entire suite.

#### Minikube setup

Minikube is the test cluster for the same reason boilerhouse-podmand manages its own
podman subprocess — we own the lifecycle end-to-end and don't depend on shared
infrastructure.

Managed via a kadai action (`.kadai/actions/minikube.sh`), paralleling how `kadai daemon`
manages the boilerhouse-podmand lifecycle:

```bash
#!/bin/bash
# kadai:name Minikube
# kadai:emoji ☸️
# kadai:description Start/stop the minikube test cluster for K8s runtime tests

set -euo pipefail

PROFILE="boilerhouse-test"
NAMESPACE="boilerhouse"

# ── Install minikube + kubectl if missing ─────────────────────────────────

install_minikube() {
  echo "minikube not found — installing..."
  case "$(uname -s)" in
    Darwin)
      if command -v brew &>/dev/null; then
        brew install minikube
      else
        echo "Error: Homebrew not found. Install minikube manually." >&2
        exit 1
      fi
      ;;
    Linux)
      curl -LO https://storage.googleapis.com/minikube/releases/latest/minikube-linux-amd64
      sudo install minikube-linux-amd64 /usr/local/bin/minikube
      rm minikube-linux-amd64
      ;;
  esac
}

install_kubectl() {
  echo "kubectl not found — installing..."
  case "$(uname -s)" in
    Darwin)
      if command -v brew &>/dev/null; then
        brew install kubectl
      else
        echo "Error: Homebrew not found. Install kubectl manually." >&2
        exit 1
      fi
      ;;
    Linux)
      curl -LO "https://dl.k8s.io/release/$(curl -sL https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"
      sudo install kubectl /usr/local/bin/kubectl
      rm kubectl
      ;;
  esac
}

command -v minikube &>/dev/null || install_minikube
command -v kubectl &>/dev/null || install_kubectl

# ── Cluster lifecycle ─────────────────────────────────────────────────────

# If cluster is already running, offer status and exit
if minikube status -p "$PROFILE" &>/dev/null; then
  echo "Cluster '$PROFILE' is already running."
  echo "  API server: $(minikube ip -p "$PROFILE"):8443"
  echo ""
  echo "To stop:   minikube stop -p $PROFILE"
  echo "To delete: minikube delete -p $PROFILE"
  exit 0
fi

echo "Starting minikube cluster '$PROFILE'..."
minikube start -p "$PROFILE" \
  --driver=docker \
  --cpus=2 \
  --memory=2048

# ── Namespace + RBAC ──────────────────────────────────────────────────────

kubectl --context="$PROFILE" get namespace "$NAMESPACE" &>/dev/null \
  || kubectl --context="$PROFILE" create namespace "$NAMESPACE"

kubectl --context="$PROFILE" -n "$NAMESPACE" apply -f - <<'EOF'
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: boilerhouse-runtime
  namespace: boilerhouse
rules:
  - apiGroups: [""]
    resources: [pods, pods/exec, pods/log, services]
    verbs: [get, list, create, delete, watch]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: boilerhouse-runtime
  namespace: boilerhouse
subjects:
  - kind: ServiceAccount
    name: default
    namespace: boilerhouse
roleRef:
  kind: Role
  name: boilerhouse-runtime
  apiGroup: rbac.authorization.k8s.io
EOF

echo ""
echo "Minikube ready: profile=$PROFILE namespace=$NAMESPACE"
echo "  API server: $(minikube ip -p "$PROFILE"):8443"
echo "  Token:      kubectl --context=$PROFILE -n $NAMESPACE create token default"
```

Usage: `bunx kadai run minikube`

Teardown: `minikube delete -p boilerhouse-test` (or `minikube stop -p boilerhouse-test`
to pause without deleting).

#### Cluster detection

In `packages/runtime-kubernetes/src/runtime.integration.test.ts`:

```typescript
import { existsSync } from "node:fs";

const PROFILE = "boilerhouse-test";

function minikubeAvailable(): boolean {
  // Step 1: is minikube installed and does our profile exist?
  const status = Bun.spawnSync(
    ["minikube", "status", "-p", PROFILE, "-o", "json"],
    { stdout: "pipe", stderr: "ignore" },
  );
  if (status.exitCode !== 0) return false;

  // Step 2: can we reach the K8s API?
  const probe = Bun.spawnSync(
    ["kubectl", "--context", PROFILE, "cluster-info"],
    { stdout: "ignore", stderr: "ignore" },
  );
  return probe.exitCode === 0;
}

const k8sAvailable = minikubeAvailable();
```

This mirrors the Podman pattern: fast file/process check first, then an HTTP-level probe
to confirm the cluster is actually responsive. Tests skip cleanly when minikube isn't
running.

#### Config extraction

When the cluster is available, extract connection details for `KubernetesConfig`:

```typescript
function getMinikubeConfig(): KubernetesConfig {
  const ip = Bun.spawnSync(["minikube", "ip", "-p", PROFILE], {
    stdout: "pipe",
  }).stdout.toString().trim();

  const token = Bun.spawnSync(
    ["kubectl", "--context", PROFILE, "-n", "boilerhouse", "create", "token", "default"],
    { stdout: "pipe" },
  ).stdout.toString().trim();

  const caCert = Bun.file(`${process.env.HOME}/.minikube/ca.crt`);

  return {
    apiUrl: `https://${ip}:8443`,
    token,
    caCert: caCert.toString(),
    namespace: "boilerhouse",
  };
}
```

#### Integration test suite

```
packages/runtime-kubernetes/src/runtime.integration.test.ts
```

```typescript
describe.skipIf(!k8sAvailable)("KubernetesRuntime (minikube)", () => {
  let runtime: KubernetesRuntime;
  const containersToCleanup: InstanceHandle[] = [];

  beforeAll(() => {
    runtime = new KubernetesRuntime(getMinikubeConfig());
  });

  afterEach(async () => {
    for (const handle of containersToCleanup) {
      await runtime.destroy(handle).catch(() => {});
    }
    containersToCleanup.length = 0;
  });

  test("create + start + destroy lifecycle");
  test("exec runs command in pod");
  test("logs returns container output");
  test("getEndpoint returns pod IP");
  test("list returns managed pod instance IDs");
  test("snapshot throws RuntimeCapabilityError");
  test("restore throws RuntimeCapabilityError");
  test("available returns true");
});
```

Run with:
```bash
bun test packages/runtime-kubernetes/src/runtime.integration.test.ts --timeout 60000
```

#### Comparison with Podman integration tests

| Aspect               | Podman                                          | Kubernetes                                            |
|----------------------|-------------------------------------------------|-------------------------------------------------------|
| External dependency  | boilerhouse-podmand daemon on Unix socket       | minikube cluster (`boilerhouse-test` profile)         |
| Detection            | `existsSync(socket)` + `curl /healthz`          | `minikube status` + `kubectl cluster-info`            |
| Skip mechanism       | `describe.skipIf(!podmanAvailable)`             | `describe.skipIf(!k8sAvailable)`                      |
| Config source        | `DAEMON_SOCKET` env / `DEFAULT_RUNTIME_SOCKET`  | `minikube ip` + `kubectl create token`                |
| Cleanup              | Track handles, `destroy()` in `afterEach`       | Track handles, `destroy()` in `afterEach`             |
| CRIU sub-suite       | `describe.skipIf(!criuAvailable)` nested block  | N/A — CRIU not supported                              |
| Timeout              | `--timeout 60000`                               | `--timeout 60000`                                     |
| Setup                | `kadai daemon` + `setup-boilerhouse-podmand.sh` | `kadai minikube` (`.kadai/actions/minikube.sh`)       |

### E2E tests (full API server)

E2E tests run the full Boilerhouse API server against all detected runtimes. Kubernetes
joins the existing matrix alongside fake and podman.

#### Detection

`apps/api/src/e2e/runtime-detect.ts` — add `kubernetes` to `RuntimeAvailability`:

```typescript
export interface RuntimeAvailability {
  fake: true;
  docker: boolean;
  podman: boolean;
  kubernetes: boolean;  // minikube boilerhouse-test profile reachable
}

function kubernetesAvailable(): boolean {
  const status = Bun.spawnSync(
    ["minikube", "status", "-p", "boilerhouse-test", "-o", "json"],
    { stdout: "pipe", stderr: "ignore" },
  );
  if (status.exitCode !== 0) return false;
  const probe = Bun.spawnSync(
    ["kubectl", "--context", "boilerhouse-test", "cluster-info"],
    { stdout: "ignore", stderr: "ignore" },
  );
  return probe.exitCode === 0;
}
```

#### Runtime matrix entry

`apps/api/src/e2e/runtime-matrix.ts`:

```typescript
const kubernetesEntry: RuntimeEntry = {
  name: "kubernetes",
  capabilities: {
    criu: false,
    exec: true,
    networking: true,
    concurrentRestore: false,
  },
  workloadFixtures: {
    minimal: fixturePath("workload-k8s-minimal.workload.ts"),
    httpserver: fixturePath("workload-k8s-httpserver.workload.ts"),
    openclaw: fixturePath("workload-k8s-openclaw.workload.ts"),
  },
  brokenWorkloadFixture: fixturePath("workload-k8s-broken.workload.ts"),
  verifyCleanup: async () => {
    const result = Bun.spawnSync([
      "kubectl", "--context", "boilerhouse-test",
      "-n", "boilerhouse",
      "get", "pods",
      "-l", "boilerhouse.dev/managed=true",
      "-o", "name",
    ]);
    const output = result.stdout.toString().trim();
    if (output.length > 0) {
      throw new Error(`Orphaned K8s pods found: ${output}`);
    }
  },
  isInstanceRunning: async (instanceId: string) => {
    const result = Bun.spawnSync([
      "kubectl", "--context", "boilerhouse-test",
      "-n", "boilerhouse",
      "get", "pod", instanceId,
      "-o", "jsonpath={.status.phase}",
    ]);
    return result.stdout.toString().trim() === "Running";
  },
};

// Add to ALL_ENTRIES
const ALL_ENTRIES: Record<string, RuntimeEntry> = {
  fake: fakeEntry,
  docker: dockerEntry,
  podman: podmanEntry,
  kubernetes: kubernetesEntry,
};

// Add to IMPLEMENTED_RUNTIMES
const IMPLEMENTED_RUNTIMES = new Set(["fake", "podman", "kubernetes"]);

// Add timeout
export const E2E_TIMEOUTS = {
  fake: { operation: 2_000, connect: 1_000 },
  docker: { operation: 30_000, connect: 10_000 },
  podman: { operation: 60_000, connect: 10_000 },
  kubernetes: { operation: 60_000, connect: 10_000 },
} as const;
```

#### E2E server wiring

`apps/api/src/e2e/e2e-helpers.ts` — add `kubernetes` case:

```typescript
} else if (runtimeName === "kubernetes") {
  const { KubernetesRuntime } = await import("@boilerhouse/runtime-kubernetes");

  // Extract config from minikube (same as integration tests)
  const ip = Bun.spawnSync(["minikube", "ip", "-p", "boilerhouse-test"], {
    stdout: "pipe",
  }).stdout.toString().trim();
  const token = Bun.spawnSync(
    ["kubectl", "--context", "boilerhouse-test", "-n", "boilerhouse",
     "create", "token", "default"],
    { stdout: "pipe" },
  ).stdout.toString().trim();

  runtime = new KubernetesRuntime({
    apiUrl: `https://${ip}:8443`,
    token,
    namespace: "boilerhouse",
  });
}
```

#### Workload fixtures

Kubernetes workload fixtures use real container images (same as podman fixtures, not
the fake runtime's in-process stubs):

```
apps/api/src/e2e/fixtures/
  workload-k8s-minimal.workload.ts     # alpine:latest, sleep infinity
  workload-k8s-httpserver.workload.ts  # simple HTTP server image, port 8080
  workload-k8s-openclaw.workload.ts    # openclaw image, port 18789
  workload-k8s-broken.workload.ts      # nonexistent image (create should fail)
```

These may share images with the podman fixtures but must define workloads with
K8s-compatible networking (no host port mapping — uses ClusterIP Services instead).

#### Running E2E tests

```bash
# All runtimes (auto-detected)
bun test apps/api/src/e2e/ --timeout 120000

# Only kubernetes
BOILERHOUSE_E2E_RUNTIMES=kubernetes bun test apps/api/src/e2e/ --timeout 120000

# Fake + kubernetes (skip podman)
BOILERHOUSE_E2E_RUNTIMES=fake,kubernetes bun test apps/api/src/e2e/ --timeout 120000
```

#### Capability-aware test skipping

Existing E2E tests that depend on CRIU (snapshot/restore, hibernate, golden snapshots)
must check capabilities and skip. The `RuntimeEntry.capabilities.criu` field drives this:

```typescript
test.skipIf(!rt.capabilities.criu)("hibernates on release", async () => {
  // ...
});
```

### CLAUDE.md update

Add to the Testing section of `CLAUDE.md`:

```markdown
### Integration tests (Kubernetes)

Require a minikube cluster with profile `boilerhouse-test`.
Set up with `bunx kadai run minikube`. Teardown with
`minikube delete -p boilerhouse-test`.

\```sh
bun test packages/runtime-kubernetes/src/runtime.integration.test.ts --timeout 60000
\```
```

## Implementation Order

1. Rename `boilerhoused` → `boilerhouse-podmand` (bulk rename, run tests to verify)
2. `RuntimeCapabilities` + `RuntimeCapabilityError` in core (unblocks everything)
3. Update `FakeRuntime` + `PodmanRuntime` with capabilities
4. `TenantDataStore` interface + `LocalTenantDataStore` implementation
5. Add `"kubernetes"` to `RuntimeType`
6. Manager capability-aware branching + TenantDataStore wiring (write failing tests first)
7. `packages/runtime-kubernetes` — translator first, then client, then runtime
8. `kadai minikube` action
9. Server wiring + E2E
