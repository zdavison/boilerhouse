# Runtime E2E Tests

## Goal

End-to-end tests that exercise the full lifecycle of workloads, tenants, instances, and snapshots against real runtime backends (Docker, Firecracker) — and always against FakeRuntime as a business-logic sanity check.

Tests must auto-detect which runtimes are available on the current system and skip those that aren't.

## Constraints

Tests interact with the system through **four surfaces only**:

1. **API** — HTTP requests to the REST endpoints
2. **Database** — direct reads when the API doesn't expose the data (e.g. activity log)
3. **Instance connections** — connecting to running instances to verify they work
4. **Runtime CLIs** — `docker ps`, `docker inspect`, etc. to verify external state

Tests must **not** call managers, runtime methods, or any internal application code during the test itself. Setup/teardown (starting the server, wiring dependencies) is fine.

---

## 1. Test Infrastructure

### 1.1 Runtime Detection

Add a utility at `apps/api/src/e2e/runtime-detect.ts`:

```ts
interface RuntimeAvailability {
  fake: true;                // always available
  docker: boolean;           // `docker info` succeeds
  firecracker: boolean;      // `firecracker --version` succeeds + /dev/kvm exists
}

function detectRuntimes(): RuntimeAvailability;
```

- `fake` is hardcoded `true`.
- `docker`: spawn `docker info`, check exit code 0.
- `firecracker`: spawn `firecracker --version`, check exit code 0 **and** `/dev/kvm` is accessible.
- Future runtimes (e.g. macOS `vz`) add a new field and detection check here.

Platform guards (for runtimes that are OS-specific):

| Runtime     | OS Required | Extra Requirements              |
|-------------|-------------|---------------------------------|
| fake        | any         | none                            |
| docker      | any         | Docker daemon running           |
| firecracker | Linux       | /dev/kvm, firecracker binary    |
| vz (future) | macOS       | Virtualization.framework access |

### 1.2 Test Matrix Helper

A helper that generates test suites per-runtime:

```ts
// apps/api/src/e2e/runtime-matrix.ts

interface RuntimeEntry {
  name: string;
  capabilities: {
    snapshot: boolean;
    exec: boolean;
    networking: boolean;
  };
  /** Workload TOML fixture path for this runtime */
  workloadFixture: string;
  /**
   * Workload TOML fixture that will fail during instance creation.
   * Used by error-recovery tests. Mechanism is runtime-specific:
   * - fake: server started with failOn config
   * - docker: workload references a nonexistent image
   * - firecracker: workload references a missing kernel/rootfs
   */
  brokenWorkloadFixture: string;
  /** Verify no orphaned resources exist via runtime CLI. No-op for fake. */
  verifyCleanup: () => Promise<void>;
  /** Check if an instance is running via runtime CLI. Always false for fake after destroy. */
  isInstanceRunning: (instanceId: string) => Promise<boolean>;
}

/**
 * Returns runtime entries filtered to only those available on this system.
 * Always includes FakeRuntime. Includes real runtimes only if detected.
 */
function availableRuntimes(): RuntimeEntry[];
```

Tests use this to parameterize:

```ts
import { availableRuntimes } from "./runtime-matrix";

for (const rt of availableRuntimes()) {
  describe(`[${rt.name}] full lifecycle`, () => {
    // ... tests using API calls only ...
  });
}
```

### 1.3 Test Workloads

Define minimal test workloads per runtime in `apps/api/src/e2e/fixtures/`:

**Working workloads** — used by most tests:

| File                        | Purpose                                            |
|-----------------------------|----------------------------------------------------|
| `workload-fake.toml`        | FakeRuntime workload (instant, no real resources)   |
| `workload-docker.toml`      | Alpine container, exposes port 8080, runs HTTP echo |
| `workload-firecracker.toml` | Minimal kernel + rootfs, runs HTTP echo             |

Each working workload exposes a simple HTTP endpoint that tests can `fetch()` to verify the instance is reachable and functional.

**Broken workloads** — used by error recovery tests to trigger creation failures:

| File                               | Failure Mechanism                                 |
|------------------------------------|---------------------------------------------------|
| `workload-fake-broken.toml`        | Server started with `failOn: new Set(["start"])`  |
| `workload-docker-broken.toml`      | References nonexistent image `boilerhouse/no-such-image:never` |
| `workload-firecracker-broken.toml` | References nonexistent kernel path                |

The broken workloads let error recovery tests run through the matrix like all other tests — each runtime has its own natural failure mode.

### 1.4 E2E Server Setup

Tests start a real API server and interact with it over HTTP:

```ts
// apps/api/src/e2e/e2e-helpers.ts

interface E2EServer {
  baseUrl: string;                     // e.g. "http://localhost:54321"
  db: DrizzleDb;                       // for direct DB assertions only
  cleanup: () => Promise<void>;        // stops server, destroys resources, removes temp files
}

/**
 * Boots the API server with the given runtime wired in.
 * For FakeRuntime: in-process with on-disk SQLite.
 * For real runtimes: same, but using the real runtime implementation.
 */
function startE2EServer(runtimeName: string): Promise<E2EServer>;
```

The `db` handle is exposed **only for read assertions** — tests never write to the DB directly.

Helper for API calls:

```ts
/** Typed fetch wrapper against the E2E server */
function api(server: E2EServer, method: string, path: string, body?: unknown): Promise<Response>;
```

### 1.5 Runtime CLI Verification

External state verification is provided by the `RuntimeEntry` methods (`verifyCleanup`, `isInstanceRunning`) defined in section 1.2. Implementations per runtime:

| Runtime     | `isInstanceRunning`                         | `verifyCleanup`                                       |
|-------------|---------------------------------------------|-------------------------------------------------------|
| fake        | Always `false` after destroy (no-op)        | No-op                                                 |
| docker      | `docker inspect --format '{{.State.Running}}'` | `docker ps --filter label=boilerhouse` returns empty |
| firecracker | Check for process with matching instanceId  | No jailer chroot dirs remain in `/srv/jailer/`        |

### 1.6 Timeouts

Real runtimes are slow. E2E tests need longer timeouts:

```ts
const E2E_TIMEOUTS = {
  fake:        { operation: 2_000,  connect: 1_000  },
  docker:      { operation: 30_000, connect: 10_000 },
  firecracker: { operation: 60_000, connect: 15_000 },
} as const;
```

Use `bun test`'s per-test timeout: `test("name", callback, timeoutMs)`.

---

## 2. API Surface Used by Tests

Every test action maps to a public API call:

| Action                   | API Call                                         |
|--------------------------|--------------------------------------------------|
| Register workload        | `POST /api/v1/workloads` (TOML body)             |
| List workloads           | `GET /api/v1/workloads`                          |
| Get workload details     | `GET /api/v1/workloads/:name`                    |
| List workload snapshots  | `GET /api/v1/workloads/:name/snapshots`          |
| Delete workload          | `DELETE /api/v1/workloads/:name`                 |
| Claim instance           | `POST /api/v1/tenants/:id/claim` `{workload}`    |
| Release instance         | `POST /api/v1/tenants/:id/release`               |
| Get tenant details       | `GET /api/v1/tenants/:id`                        |
| List instances           | `GET /api/v1/instances`                          |
| Get instance             | `GET /api/v1/instances/:id`                      |
| Get instance endpoint    | `GET /api/v1/instances/:id/endpoint`             |
| Stop instance            | `POST /api/v1/instances/:id/stop`                |
| Hibernate instance       | `POST /api/v1/instances/:id/hibernate`           |
| Destroy instance         | `POST /api/v1/instances/:id/destroy`             |
| List snapshots           | `GET /api/v1/snapshots`                          |
| WebSocket events         | `WS /ws`                                         |
| Health check             | `GET /api/v1/health`                             |
| System stats             | `GET /api/v1/stats`                              |

---

## 3. E2E Scenarios

All scenarios run once per available runtime. FakeRuntime always runs. Real runtimes run only if detected.

### 3.1 Instance Lifecycle (Basic)

**File:** `apps/api/src/e2e/instance-lifecycle.e2e.test.ts`

| Step | Action                                                | Assertions                                                        |
|------|-------------------------------------------------------|-------------------------------------------------------------------|
| 1    | `POST /api/v1/workloads` with runtime's test TOML     | 201, response contains `workloadId`                               |
| 2    | `POST /api/v1/tenants/e2e-test-1/claim` `{workload}`  | 200, returns `{ instanceId, endpoint, source }`                   |
| 3    | `GET /api/v1/instances/:id`                            | Status is `active`, workloadId matches                            |
| 4    | `GET /api/v1/instances/:id/endpoint`                   | Returns `{ host, port }` matching claim response                  |
| 5    | `fetch(http://${host}:${port})`                        | Gets HTTP response from instance (skip if `!capabilities.networking`) |
| 6    | `POST /api/v1/tenants/e2e-test-1/release`              | 200                                                               |
| 7    | `GET /api/v1/instances/:id`                            | Status is `destroyed` or `hibernated` (depends on workload idle.action) |
| 8    | `GET /api/v1/instances?status=active`                  | Instance not in active list                                       |
| 9    | `rt.isInstanceRunning(instanceId)`                     | Returns `false` — runtime resources cleaned up                    |
| 10   | DB: query `activity_log` by instanceId                 | Contains created + stopped/hibernated entries                     |

### 3.2 Snapshot & Restore (Runtimes with Snapshot Support)

**File:** `apps/api/src/e2e/snapshot-lifecycle.e2e.test.ts`

Skip entirely if `!capabilities.snapshot`.

| Step | Action                                                 | Assertions                                                     |
|------|--------------------------------------------------------|----------------------------------------------------------------|
| 1    | `POST /api/v1/workloads` — register workload           | 201                                                            |
| 2    | `GET /api/v1/workloads/:name/snapshots`                 | Golden snapshot exists with status `ready`                     |
| 3    | `POST /api/v1/tenants/e2e-snap-1/claim`                 | 200, instance active                                           |
| 4    | `POST /api/v1/instances/:id/hibernate`                  | 200, returns `{ snapshotId }`                                  |
| 5    | `GET /api/v1/instances/:id`                             | Status is `hibernated`                                         |
| 6    | `GET /api/v1/snapshots`                                 | Tenant snapshot exists in list                                 |
| 7    | `POST /api/v1/tenants/e2e-snap-1/claim`                 | 200, source is `"snapshot"`, new instanceId                    |
| 8    | `GET /api/v1/instances/:id/endpoint`                    | New instance reachable                                         |
| 9    | `fetch(endpoint)`                                       | Instance responds (skip if `!capabilities.networking`)         |
| 10   | `POST /api/v1/tenants/e2e-snap-1/release`               | Clean teardown                                                 |

### 3.3 Full Tenant Claim/Release Cycle

**File:** `apps/api/src/e2e/tenant-lifecycle.e2e.test.ts`

| Step | Action                                                 | Assertions                                                     |
|------|--------------------------------------------------------|----------------------------------------------------------------|
| 1    | `POST /api/v1/workloads` — register workload           | 201, golden snapshot created                                   |
| 2    | `GET /api/v1/workloads/:name/snapshots`                 | Confirms golden snapshot `ready`                               |
| 3    | `POST /api/v1/tenants/e2e-tenant-1/claim`               | 200, `source: "golden"`, returns endpoint                     |
| 4    | `GET /api/v1/tenants/e2e-tenant-1`                      | `instanceId` set, status shows active                          |
| 5    | `fetch(endpoint)`                                       | Instance reachable (skip if `!capabilities.networking`)        |
| 6    | `POST /api/v1/tenants/e2e-tenant-1/release`             | 200                                                            |
| 7    | `GET /api/v1/tenants/e2e-tenant-1`                      | `instanceId` cleared                                           |
| 8    | `GET /api/v1/instances/:id`                             | Original instance `destroyed` or `hibernated`                  |
| 9    | If snapshot-capable: `GET /api/v1/tenants/e2e-tenant-1` | `lastSnapshotId` set                                           |
| 10   | `POST /api/v1/tenants/e2e-tenant-1/claim`               | Source is `"snapshot"` (not `"golden"`), new instanceId        |
| 11   | `POST /api/v1/tenants/e2e-tenant-1/release`             | Clean release                                                  |
| 12   | DB: query `activity_log` for tenant                     | Full event trail: created, hibernated, restored, etc.          |

### 3.4 Concurrent Tenants

**File:** `apps/api/src/e2e/concurrent-tenants.e2e.test.ts`

| Step | Action                                                         | Assertions                                                 |
|------|----------------------------------------------------------------|------------------------------------------------------------|
| 1    | `POST /api/v1/workloads` — register workload                   | 201                                                        |
| 2    | Claim 3 tenants in parallel via `Promise.all`                   | All return 200, all get separate instanceIds               |
| 3    | `GET /api/v1/instances?status=active`                           | 3 active instances                                         |
| 4    | Each endpoint responds independently                            | 3 distinct `host:port` pairs (skip if `!capabilities.networking`) |
| 5    | Release all 3 in parallel                                       | All return 200                                             |
| 6    | `GET /api/v1/instances?status=active`                           | No active instances remaining                              |
| 7    | `rt.verifyCleanup()`                                            | No orphaned runtime resources                              |

### 3.5 Error Recovery

**File:** `apps/api/src/e2e/error-recovery.e2e.test.ts`

Runs across the matrix. Each runtime provides a `brokenWorkloadFixture` that triggers failures through runtime-native mechanisms (see section 1.3).

| Step | Action                                                          | Assertions                                                       |
|------|-----------------------------------------------------------------|------------------------------------------------------------------|
| 1    | `POST /api/v1/workloads` with `rt.brokenWorkloadFixture`        | 201 (workload registers fine, failure happens at instance create) |
| 2    | `POST /api/v1/tenants/e2e-err-1/claim`                          | Returns error status (not 200)                                   |
| 3    | `GET /api/v1/instances?status=active`                            | No orphaned active instances                                     |
| 4    | `GET /api/v1/stats`                                              | Instance counts are consistent                                   |
| 5    | `rt.verifyCleanup()`                                             | No orphaned runtime resources (containers, VMs)                  |
| 6    | Register a **working** workload, claim a tenant                  | 200, instance active — system recovered and is functional        |
| 7    | Release tenant                                                   | Clean teardown                                                   |

### 3.6 Destroy Running Instances

**File:** `apps/api/src/e2e/destroy.e2e.test.ts`

| Step | Action                                              | Assertions                                                    |
|------|-----------------------------------------------------|---------------------------------------------------------------|
| 1    | Register workload, claim tenant                      | Instance `active`                                             |
| 2    | `POST /api/v1/instances/:id/destroy`                 | 200, returns `{ status: "destroyed" }`                        |
| 3    | `GET /api/v1/instances/:id`                          | Status is `destroyed`                                         |
| 4    | `POST /api/v1/instances/:id/stop`                    | Returns error (cannot operate on destroyed instance)          |
| 5    | `POST /api/v1/instances/:id/hibernate`               | Returns error (cannot operate on destroyed instance)          |
| 6    | `rt.isInstanceRunning(instanceId)`                   | Returns `false` — runtime resources cleaned up                |

### 3.7 EventBus / WebSocket Integration

**File:** `apps/api/src/e2e/events.e2e.test.ts`

| Step | Action                                              | Assertions                                                    |
|------|-----------------------------------------------------|---------------------------------------------------------------|
| 1    | Open WebSocket connection to `ws://.../ws`           | Connection established                                       |
| 2    | `POST /api/v1/workloads` — register workload         | —                                                             |
| 3    | `POST /api/v1/tenants/:id/claim`                     | —                                                             |
| 4    | Collect WebSocket messages                           | Receives `instance.state` (starting → active), `tenant.claimed` |
| 5    | `POST /api/v1/tenants/:id/release`                   | —                                                             |
| 6    | Collect WebSocket messages                           | Receives `instance.state` changes, `tenant.released`          |
| 7    | Verify event order                                   | Events arrive in correct causal order                         |
| 8    | Verify event payloads                                | `instanceId`, `tenantId` match API responses                  |

---

## 4. File Structure

```
apps/api/src/e2e/
├── runtime-detect.ts                    # OS/binary detection
├── runtime-matrix.ts                    # Runtime entries, capabilities, CLI verification
├── e2e-helpers.ts                       # Server setup, api() helper, cleanup
├── fixtures/
│   ├── workload-fake.toml
│   ├── workload-fake-broken.toml
│   ├── workload-docker.toml
│   ├── workload-docker-broken.toml
│   ├── workload-firecracker.toml
│   └── workload-firecracker-broken.toml
├── instance-lifecycle.e2e.test.ts
├── snapshot-lifecycle.e2e.test.ts
├── tenant-lifecycle.e2e.test.ts
├── concurrent-tenants.e2e.test.ts
├── error-recovery.e2e.test.ts
├── destroy.e2e.test.ts
└── events.e2e.test.ts
```

---

## 5. Running

```bash
# All E2E tests (auto-detects available runtimes)
bun test apps/api/src/e2e/

# Only FakeRuntime (CI-safe, no real runtimes needed)
BOILERHOUSE_E2E_RUNTIMES=fake bun test apps/api/src/e2e/

# Specific runtime
BOILERHOUSE_E2E_RUNTIMES=docker bun test apps/api/src/e2e/

# Multiple
BOILERHOUSE_E2E_RUNTIMES=fake,docker bun test apps/api/src/e2e/
```

The `BOILERHOUSE_E2E_RUNTIMES` env var overrides auto-detection. When unset, all detected runtimes are tested. When set, only the listed runtimes run (still skipped if not actually available).

---

## 6. Implementation Order

| Phase | Work                                                                                 | Depends On               |
|-------|--------------------------------------------------------------------------------------|--------------------------|
| 1     | `runtime-detect.ts`, `runtime-matrix.ts`, `e2e-helpers.ts`                           | —                        |
| 2     | Fake workload fixtures (working + broken) + `instance-lifecycle.e2e.test.ts`         | Phase 1                  |
| 3     | `tenant-lifecycle.e2e.test.ts`, `snapshot-lifecycle.e2e.test.ts`                     | Phase 2                  |
| 4     | `concurrent-tenants.e2e.test.ts`, `error-recovery.e2e.test.ts`, `destroy.e2e.test.ts`, `events.e2e.test.ts` | Phase 3  |
| 5     | Docker workload fixtures (working + broken) + Docker `RuntimeEntry`                  | Phase 4 + docker runtime |
| 6     | Firecracker workload fixtures (working + broken) + Firecracker `RuntimeEntry`        | Phase 4 + FC runtime     |
