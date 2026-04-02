# Boilerhouse Kubernetes Operator Design

## Goal

Replace the imperative HTTP API with a declarative Kubernetes operator so that Boilerhouse behaves like a native K8s citizen. Users define CRDs and YAML; the operator reconciles desired state. This integrates with existing K8s tooling (GitOps, kubectl, RBAC, etc.) instead of requiring a proprietary API.

The Docker path retains the existing API. The operator is the sole interface for K8s deployments.

## Package Structure

Two new packages, one new app:

```
packages/
  core/                    (existing) domain types, Runtime interface, workload schema
  db/                      (existing) Drizzle schema, migrations, loaders
  domain/                  NEW: extracted managers + recovery + event infrastructure
  runtime-docker/          (existing)
  runtime-kubernetes/      (existing, extended) K8s runtime + watch/status client
  storage/                 (existing) blob stores
  ...

apps/
  api/                     (existing, slimmed) HTTP routes + bootstrap, imports domain
  operator/                NEW: K8s operator, watches CRDs, imports domain
  ...
```

### @boilerhouse/domain

Extracted from `apps/api/src/` with no logic changes:

| Module | Description |
|--------|-------------|
| `instance-manager.ts` | Container lifecycle (create, destroy, hibernate, restart) |
| `tenant-manager.ts` | Claim/release orchestration with deduplication |
| `pool-manager.ts` | Warm pool maintenance + health checking |
| `tenant-data.ts` | Overlay archive storage (extract/inject/restore) |
| `idle-monitor.ts` | Timer-based idle detection |
| `watch-dirs-poller.ts` | Filesystem activity polling for idle calculation |
| `recovery.ts` | Crash recovery (reconcile DB vs runtime) |
| `transitions.ts` | State machine validators |
| `event-bus.ts` | In-process pub/sub for real-time events |
| `audit-logger.ts` | Persistent audit trail + event bus facade |

All managers already take dependencies (Runtime, DrizzleDb, BlobStore, Logger) as constructor arguments. No interface changes needed beyond one new abstraction:

```typescript
interface SecretResolver {
  resolve(ref: SecretRef): Promise<string>;
}
```

- `apps/api` implements this with the existing SecretStore (AES-encrypted SQLite)
- `apps/operator` implements this with the K8s Secrets API

### apps/api (slimmed)

Retains:
- HTTP routes (`routes/`)
- Elysia app setup
- Bootstrap wiring (imports from `@boilerhouse/domain`)
- Auth middleware, WebSocket plugin
- Workload file watcher (`*.workload.ts` — dev/Docker mode only)

### apps/operator (new)

Contains:
- CRD TypeScript type definitions
- Four reconcile controllers (Workload, Pool, Claim, Trigger)
- K8s watch/status client (extends existing `@boilerhouse/runtime-kubernetes` client)
- Operator bootstrap (wires domain managers + starts controllers)
- Small internal API server
- Leader election via K8s Lease
- Finalizer management

## CRD Definitions

API group: `boilerhouse.dev/v1alpha1`

### BoilerhouseWorkload

Defines a containerized service template. Replaces `*.workload.ts` files.

```yaml
apiVersion: boilerhouse.dev/v1alpha1
kind: BoilerhouseWorkload
metadata:
  name: my-agent
  namespace: boilerhouse
spec:
  version: "1.0.0"
  image:
    ref: ghcr.io/myorg/agent:latest
  resources:
    vcpus: 2
    memoryMb: 512
    diskGb: 10
  network:
    access: restricted          # none | restricted | unrestricted
    expose:
      - guest: 8080
    allowlist:
      - api.anthropic.com
    credentials:
      - domain: api.anthropic.com
        secretRef:
          name: anthropic-key   # native K8s Secret
          key: api-key
        headers:
          x-api-key: "{{value}}"
    websocket: /ws
  filesystem:
    overlayDirs:
      - /home/user/.cache
    encryptOverlays: true
  idle:
    timeoutSeconds: 300
    action: hibernate           # hibernate | destroy
    watchDirs:
      - /home/user/.cache
  health:
    intervalSeconds: 10
    unhealthyThreshold: 3
    httpGet:
      path: /health
      port: 8080
  entrypoint:
    cmd: /app/agent
    args: ["--mode", "interactive"]
    env:
      LOG_LEVEL: debug
    workdir: /app
  # Use standard K8s annotations/labels for descriptive metadata:
  # metadata:
  #   annotations:
  #     boilerhouse.dev/description: "My AI agent"
  #     boilerhouse.dev/owner: "team-x"
status:
  phase: Ready                  # Creating | Ready | Error
  detail: ""
  observedGeneration: 1
```

Credentials reference native K8s Secrets via `secretRef` instead of `${global-secret:...}` syntax.

### BoilerhousePool

Separated from workload so pool sizing can change without triggering workload reconciliation.

```yaml
apiVersion: boilerhouse.dev/v1alpha1
kind: BoilerhousePool
metadata:
  name: my-agent
  namespace: boilerhouse
spec:
  workloadRef: my-agent       # metadata.name of a BoilerhouseWorkload in same namespace
  size: 3
  maxFillConcurrency: 2
status:
  ready: 2
  warming: 1
  phase: Healthy                # Healthy | Degraded | Error
```

### BoilerhouseClaim

Created by tenants or automation to acquire an instance.

```yaml
apiVersion: boilerhouse.dev/v1alpha1
kind: BoilerhouseClaim
metadata:
  name: tenant-alice-my-agent
  namespace: boilerhouse
spec:
  tenantId: alice
  workloadRef: my-agent       # metadata.name of a BoilerhouseWorkload in same namespace
status:
  phase: Active                 # Pending | Active | Releasing | Released
  instanceId: inst-abc123
  endpoint:
    host: my-agent-inst-abc123.boilerhouse.svc
    port: 8080
  source: pool                  # pool | cold
  claimedAt: "2026-04-02T12:00:00Z"
```

Deleting the CR triggers release (overlay extraction + hibernate/destroy via finalizer).

When idle timeout fires, the operator sets `status.phase = Released` but does not delete the CR. Released claims stay Released — the operator does not auto-re-claim, which would create an infinite idle/re-provision cycle. To resume, the tenant or automation must either:
- Delete and recreate the Claim CR (simple, GitOps-friendly)
- Set `spec.resume: true` to signal the operator to re-claim (then the operator clears it after claiming)

Trigger-created claims follow the same pattern: the trigger creates a new Claim on demand, and idle timeout releases it without re-provisioning.

### BoilerhouseTrigger

Maps the current trigger system to a CRD.

```yaml
apiVersion: boilerhouse.dev/v1alpha1
kind: BoilerhouseTrigger
metadata:
  name: slack-support
  namespace: boilerhouse
spec:
  type: slack                   # webhook | slack | telegram | cron
  workloadRef: my-agent       # metadata.name of a BoilerhouseWorkload in same namespace
  tenant:
    from: event
    prefix: "slack-"
  driver: claude-code
  driverOptions:
    model: sonnet
  guards:
    - type: allowlist
      config:
        users: ["U123", "U456"]
  config:
    appToken:
      secretRef:
        name: slack-credentials
        key: app-token
status:
  phase: Active                 # Active | Error
  detail: ""
```

All CRDs use native K8s Secrets with `secretRef` fields.

## Reconcile Loop Details

### Workload Controller

```
Watch: BoilerhouseWorkload

Reconcile(workload):
  1. Validate spec (reuse workload schema from @boilerhouse/core)
  2. Resolve image ref
  3. Upsert workload row in DB
  4. Set status.phase = Ready (or Error with detail)
  5. Set status.observedGeneration = metadata.generation

On update (spec change):
  - Re-validate, update DB row
  - PoolController picks up changes via its watch on BoilerhouseWorkload

On delete (finalizer):
  - If active BoilerhouseClaims reference this workload: reject (keep finalizer)
  - Otherwise: drain pool, remove DB row, remove finalizer
```

### Pool Controller

```
Watch: BoilerhousePool + BoilerhouseWorkload (referenced)

Reconcile(pool):
  1. Look up referenced BoilerhouseWorkload — if not Ready, requeue
  2. Compare spec.size vs PoolManager.getPoolDepth()
  3. Under target: PoolManager.replenish()
  4. Over target: destroy excess ready instances
  5. Update status.ready, status.warming, status.phase
  6. Requeue after 30s (periodic health check)

On BoilerhouseWorkload update:
  - PoolManager.prime(drainExisting=true) — replace pool with new spec

On delete:
  - PoolManager.drain()
```

### Claim Controller

```
Watch: BoilerhouseClaim

Reconcile(claim):
  If being deleted (deletionTimestamp set):
    1. TenantManager.release(tenantId, workloadId)
    2. Remove finalizer

  If status.phase is empty (new):
    1. Add finalizer
    2. Set status.phase = Pending
    3. TenantManager.claim(tenantId, workloadId)
    4. Success: set phase=Active, instanceId, endpoint, source, claimedAt
    5. Failure: set phase=Error with detail, requeue with backoff

  If status.phase is Active:
    - No-op (idempotent)

  If status.phase is Released:
    - No-op (stays Released until user acts)
    - If spec.resume is set: re-claim, set phase=Active, clear spec.resume

Idle timeout (IdleMonitor → TenantManager.release()):
  - Operator sets claim status.phase = Released
  - Does NOT delete the CR
  - Does NOT auto-re-claim (avoids infinite idle/re-provision cycle)
```

### Trigger Controller

```
Watch: BoilerhouseTrigger

Reconcile(trigger):
  1. Validate spec, resolve secretRefs
  2. Start or update trigger adapter (webhook, slack, telegram, cron)
  3. Wire dispatch to TenantManager.claim()
  4. Set status.phase = Active (or Error)

On delete:
  - Stop trigger adapter
```

## Operator Infrastructure

### K8s Client

Extends the existing REST client in `@boilerhouse/runtime-kubernetes` with:
- **Watch**: HTTP streaming on CRD endpoints with bookmark/resourceVersion tracking
- **Status patch**: JSON merge patch on `/status` subresource
- **Finalizer management**: strategic merge patch to add/remove finalizers

No external operator framework. TypeScript throughout, consistent with existing codebase.

### Leader Election

K8s Lease object (`boilerhouse-operator-leader`). Only the leader runs reconcile loops. Standby replicas wait for lease expiry. Required because the operator writes to a single SQLite database.

### Database

SQLite stored locally in the operator pod. The CRDs are the user-facing source of truth; the DB is an internal implementation detail for the domain managers' state machines and queries. The DB is ephemeral — on pod restart or leader failover, recovery logic rebuilds state by reconciling CRDs and actual pods in the cluster. This is the same recovery pattern the API uses today, and avoids PVC complications with leader election (ReadWriteOnce PVCs can't be shared across replicas).

### Deployment Model

```yaml
Deployment: boilerhouse-operator
  replicas: 2 (one active via lease, one standby)
  volumes:
    - emptyDir for SQLite (ephemeral, rebuilt via recovery on restart)
  serviceAccount: boilerhouse-operator

ClusterRole: boilerhouse-operator
  - boilerhouse.dev CRDs: watch, list, get, patch (status + finalizers)
  - pods, services, configmaps, networkpolicies: create, get, list, delete
  - secrets: get (for credential resolution)
  - coordination.k8s.io/leases: get, create, update (leader election)

ServiceAccount: boilerhouse-operator
  bound to ClusterRole via ClusterRoleBinding
```

### Small Internal API

Cluster-internal HTTP server for operations beyond kubectl:

- `POST /api/v1/instances/:id/snapshot` — trigger manual snapshot
- `POST /api/v1/instances/:id/overlay/extract` — force overlay extraction
- `GET /api/v1/instances/:id/stats` — container resource stats

Exposed via a ClusterIP Service. No auth (cluster-internal trust boundary).

Standard operations use kubectl directly:
- `kubectl exec` / `kubectl logs` on managed pods
- `kubectl get boilerhouseclaim` for endpoint info

### Error Handling

All controllers follow K8s conventions:
- Transient errors: requeue with exponential backoff
- Permanent errors (invalid spec, missing secret): set status.phase = Error, no requeue
- Status update conflict: immediate requeue (re-read + retry)

## Testing Strategy

### Unit Tests

Domain manager tests move with the code to `packages/domain/`. Operator controller tests use `FakeRuntime` + in-memory SQLite:

1. Set up CRD object in desired state
2. Call `reconcile()`
3. Assert DB state, status patches, and runtime calls

### Integration Tests

`tests/integration/operator.integration.test.ts`:
- Operator against real minikube cluster
- Apply CRDs, verify pods/services/networkpolicies created
- Create Claim, verify instance up + endpoint populated
- Delete Claim, verify release + cleanup
- Modify Pool, verify scale up/down

### E2E Tests

Extend existing E2E suite. Add parallel path that tests via `kubectl apply` of CRD manifests and `kubectl get` for status. Uses `BOILERHOUSE_E2E_RUNTIMES=kubernetes` flag.

## Summary

| Component | Role |
|-----------|------|
| `@boilerhouse/domain` | Extracted managers — shared between API and operator |
| `apps/operator` | CRD controllers + K8s watch/reconcile + small API |
| `BoilerhouseWorkload` | Workload definition (replaces `*.workload.ts`) |
| `BoilerhousePool` | Pool sizing (independent of workload lifecycle) |
| `BoilerhouseClaim` | Tenant instance acquisition (create=claim, delete=release) |
| `BoilerhouseTrigger` | Event-driven workload activation |
| `SecretResolver` | One new interface for credential resolution |
| Native K8s Secrets | Replace encrypted SQLite secret store |
