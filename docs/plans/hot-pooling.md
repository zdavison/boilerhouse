# Hot-Pooling Plan

## Goal

Minimise the time between a trigger firing (e.g. a WhatsApp message, Slack command, webhook)
and having a live, personalised container ready to receive traffic. The target path is:

1. Trigger fires for a tenant
2. Boilerhouse claims a warm container from the pool for the tenant
3. Boilerhouse copies the tenant's data overlay into the claimed container
4. Tenant can use the instance immediately

After this work, CRIU is removed entirely. There are no checkpoints, no restores — only live
containers and filesystem overlays.

---

## Why Hot-Pooling

The current claim hierarchy walks a prioritised fallback chain:

```
tenant snapshot (CRIU) → golden + overlay → golden → cold boot
```

Even the fastest path (tenant CRIU snapshot) takes seconds because CRIU restore is slow.
The golden snapshot path is faster but still adds latency for the overlay injection step.

Hot-pooling eliminates the restore step completely. A pool of containers is already running and
healthy before any tenant arrives. Claiming becomes:

```
pick warm container → inject overlay → done
```

There is no checkpoint, no restore, no wait for container startup. The only variable latency is
the overlay copy, which is a local `tar` extract into a running container's filesystem.

Pool instances are **never re-used**. When a tenant's session ends (explicit release or idle
timeout), the container is destroyed immediately. The pool is replenished in the background. This
avoids any risk of data leakage between tenants and removes the need for cleanup logic after
tenant use.

---

## Architecture Overview

### Pool

A `PoolManager` maintains a target number of warm, unclaimed containers per workload. Each pool
instance is a fully started container that has passed the workload's health checks. It holds no
tenant identity and carries no tenant data.

```
Workload "my-agent"
  Pool: [instance-a (ready), instance-b (ready), instance-c (ready)]
  Target size: N (configurable per workload)
```

Pool state is tracked in the database. A new `pool_instances` table (or an `origin: "pool"`
flag on the existing `instances` table) marks which instances belong to the warm pool and are
available for assignment.

### Claim Path

```
POST /tenants/{tenantId}/claim { workload: "my-agent" }
  ↓
PoolManager.acquire(workloadId)
  ├─ Try: SELECT one ready pool instance (atomic CAS)
  │   └─ Return immediately
  ├─ Else: SELECT one warming pool instance (atomic CAS)
  │   └─ Await its warmup (health checks pass), then return
  ├─ Else: no pool instances at all
  │   └─ Start a new instance, await warmup, then return
  └─ In all cases, mark acquired instance as unavailable to other claims
  ↓
TenantDataStore.injectOverlay(instanceHandle, tenantId, workloadId)
  ├─ Retrieve tenant's overlay tar from storage
  ├─ runtime.exec(handle, "tar -xz -C / ") streaming overlay bytes
  └─ (no-op if tenant has no prior overlay)
  ↓
Transition instance: pool → active, assign tenantId
  ↓
Return { endpoint, source: "pool" | "pool+data" }
  ↓
PoolManager.replenish(workloadId)         ← background, non-blocking
  └─ Start a new container to bring pool back to target size
```

`acquire()` **always** returns an instance — it never returns null. There is a single code path
for all claims:

1. **Ready instance available** — instant
2. **No ready, but warming in progress** — wait for it (already partway through startup)
3. **Pool completely empty** — start a new one and wait (same startup logic as replenish)

All three cases use the same underlying instance startup path. The only difference is how long
the caller waits. This eliminates the separate "cold boot" fallback in `TenantManager` — the
pool owns all instance creation.

### Release Path

```
POST /tenants/{tenantId}/release
  ↓
TenantDataStore.extractOverlay(instanceHandle, tenantId, workloadId)
  ├─ runtime.exec(handle, "tar -cz overlay_dirs") → stream
  └─ Write tar to tenant overlay storage
  ↓
InstanceManager.destroy(instanceHandle)   ← no hibernation, no snapshot
  ↓
Delete claim row
  ↓
PoolManager.replenish(workloadId)         ← ensure pool is topped up
```

---

## Detailed Component Changes

### 1. PoolManager (new — `apps/api/src/pool-manager.ts`)

Responsible for:
- Keeping N warm instances alive per workload
- Handling pool `acquire` (atomic assignment to a tenant)
- Replenishment after each assignment or destruction
- Draining the pool when a workload is deregistered
- Surfacing pool depth as a metric
- **Gating the workload "ready" state** (replaces `GoldenCreator`)

Key methods:

```typescript
class PoolManager {
  // Start the first pool instance, health-check it, and transition the workload
  // to "ready" once it passes. The validated instance stays in the pool.
  // Replaces GoldenCreator — this is the workload readiness gate.
  async prime(workloadId: WorkloadId): Promise<void>

  // Atomically take one instance from the pool. Prefers ready instances;
  // if none are ready, awaits a warming instance. If pool is completely
  // empty, starts a new instance and awaits it. Always returns a handle.
  async acquire(workloadId: WorkloadId): Promise<InstanceHandle>

  // Start enough new instances to reach the target pool size.
  // Runs in the background; does not block the claim path.
  async replenish(workloadId: WorkloadId): Promise<void>

  // Destroy all pool instances for a workload (e.g. image update).
  async drain(workloadId: WorkloadId): Promise<void>
}
```

`prime()` replaces `GoldenCreator` entirely. The flow is the same as before — workload is
registered, a bootstrap container is started, health checks run — but instead of checkpointing
and discarding the container, it stays alive as the first pool member. The workload transitions
to `"ready"` when that first health check passes. Subsequent pool members are filled in the
background by `replenish()` using the exact same code path.

Pool target size is defined in the workload schema:

```typescript
pool?: {
  size: number          // target warm instances (default: 3)
  max_fill_concurrency: number  // how many to start in parallel when filling (default: 2)
}
```

### 2. Database Schema (`packages/db/src/schema.ts`)

Add `poolStatus` column to `instances`:

```typescript
poolStatus: text("pool_status")
  .$type<"warming" | "ready" | "acquired" | null>()
```

All instances are created via the pool, so there is no need for an `origin` column. `poolStatus`
tracks where the instance is in the pool lifecycle: `warming` (starting up, health checks
pending), `ready` (healthy, available for acquisition), `acquired` (claimed by a tenant, will
transition to a normal active instance). `null` means the instance has left the pool lifecycle
(it's now a regular active/destroying/destroyed instance).

### 3. TenantManager (`apps/api/src/tenant-manager.ts`)

Replace the CRIU-based restore hierarchy with:

```typescript
async claim(tenantId, workloadId): Promise<ClaimResult> {
  // 1. Existing active claim
  const existing = await this.findActiveClaim(tenantId)
  if (existing) return { source: "existing", ...existing }

  // 2. Acquire from pool — always returns an instance.
  //    Instant if ready, waits if warming/empty.
  const instance = await this.poolManager.acquire(workloadId)
  await this.tenantData.injectOverlay(instance, tenantId, workloadId)
  await this.activateClaim(tenantId, instance)
  this.poolManager.replenish(workloadId)  // fire-and-forget
  const hasData = await this.tenantData.hasOverlay(tenantId, workloadId)
  return { source: hasData ? "pool+data" : "pool", endpoint: ... }
}
```

### 4. Remove CRIU Code Paths

The following are removed once hot-pooling is in place:

- `GoldenCreator` — replaced by `PoolManager.prime()`, which serves as the workload readiness
  gate using the same start + health-check logic, without the checkpoint step
- `SnapshotManager` — no more snapshot lifecycle
- `InstanceManager.hibernate()` — no hibernation, destroy directly on release
- `runtime.snapshot()` and `runtime.restore()` from the `Runtime` interface
- `snapshots` table (or leave for historical data, stop writing)
- `BOILERHOUSE_CRIU_AVAILABLE` env var and all conditional logic around it
- `snapshotLocks` map in `TenantManager`
- `lastSnapshotId` on tenant rows (replaced by overlay-only persistence)

The `Runtime` interface simplifies to:

```typescript
interface Runtime {
  create(workload, instanceId, options?): Promise<InstanceHandle>
  start(handle): Promise<void>
  destroy(handle): Promise<void>
  exec(handle, command, stdin?): Promise<ExecResult>
  getEndpoint(handle): Promise<Endpoint>
  list(): Promise<InstanceId[]>
  logs?(handle, tail?): Promise<string | null>
  available(): Promise<boolean>
}
```

`capabilities` is removed entirely — there are no optional features. Every runtime supports
`create`, `start`, `destroy`, `exec`. The pool layer sits above the runtime and works the same
regardless of backend.

### 5. Dashboard UI Cleanup (`apps/dashboard/`)

The dashboard has snapshot and golden references throughout that need to be removed or replaced
with pool-aware equivalents.

**Remove entirely:**

- **Snapshots page** (`SnapshotList.tsx`) — the entire page and its nav entry in `app.tsx`
  (`/entities/snapshots` route, `Camera` icon nav item)
- **`SnapshotSummary` type** and `fetchSnapshots()` in `api.ts` — no snapshot API to call
- **Golden snapshot node** in `WorkloadList.tsx` — the `GoldenSnapshotNode` type, the golden
  snapshot tree rendering (lines building the golden → tenant snapshot hierarchy), and the
  yellow `"golden"` label/styling
- **Snapshot metrics** in `MetricsPage.tsx` — golden queue depth stat card, snapshot
  creates/disk usage sections (golden + tenant snapshot bytes tracking)
- **Golden snapshot activity colouring** in `ActivityLog.tsx` — the yellow colour for
  "restored from golden" events

**Replace with pool equivalents:**

- **Workload "not ready" message** in `WorkloadDetail.tsx` — currently says "claims are
  disabled until the golden snapshot is created". Change to "claims are disabled until the
  pool has warmed its first instance" (or similar)
- **Metrics** — replace snapshot metrics with pool metrics: pool depth per workload, pool
  replenish rate, acquire latency (instant vs waited-for-warming vs waited-for-cold)
- **Claim source labels** — activity log and metrics currently track `source: "golden"`,
  `"snapshot"`, `"cold"`. Replace with `"pool"`, `"pool+data"`

### 6. Overlay Injection into a Live Container

The existing `TenantDataStore` already stores overlays as `tar.gz`. The missing piece is
injecting them into a **running** container (currently only done via `restore` options in the
CRIU path).

Implementation:

```typescript
// apps/api/src/tenant-data.ts
async injectOverlay(handle: InstanceHandle, tenantId, workloadId): Promise<void> {
  const overlayPath = this.store.restoreOverlay(tenantId, workloadId)
  if (!overlayPath) return
  const tarStream = fs.createReadStream(overlayPath)
  // Stream tar into container via exec stdin
  await this.runtime.exec(handle, ["tar", "-xz", "-C", "/"], { stdin: tarStream })
}

async extractOverlay(handle: InstanceHandle, tenantId, workloadId): Promise<void> {
  const { filesystem } = await this.workloadLoader.get(workloadId)
  if (!filesystem?.overlay_dirs?.length) return
  const dirs = filesystem.overlay_dirs.join(" ")
  const result = await this.runtime.exec(handle, ["tar", "-cz", ...filesystem.overlay_dirs])
  await this.store.saveOverlayBuffer(tenantId, workloadId, result.stdout)
}
```

Both Podman and Kubernetes runtimes already support `exec`. The `exec` interface needs an
optional `stdin` parameter added to support streaming input for injection.

---

## End-to-End Flow After Implementation

Example using an existing trigger adapter (e.g. Slack, webhook):

```
1. Trigger fires (e.g. Slack message, webhook POST)

2. Adapter resolves tenantId from trigger context

3. Dispatcher.dispatch(event)
   ├─ TenantManager.claim(tenantId, workloadId)
   │   ├─ PoolManager.acquire(workloadId) → warm container
   │   ├─ TenantDataStore.injectOverlay(handle, tenantId)  ← copy data
   │   └─ Return { endpoint, source: "pool+data" }
   ├─ waitForReady(endpoint)   ← should be near-instant (already running)
   ├─ POST message to container
   └─ Adapter responds to user

4. Idle timeout fires (or tenant sends /done)
   ├─ TenantDataStore.extractOverlay(handle, tenantId)
   ├─ InstanceManager.destroy(handle)
   └─ PoolManager.replenish(workloadId)   ← start a fresh one
```

---

## Migration Plan

### Phase 1 — Hot-Pooling alongside CRIU

- Implement `PoolManager` and pool DB schema
- Add `pool.size` to workload config
- Implement `prime()` as the workload readiness gate (start instance, health-check, workload → "ready", instance stays in pool)
- Modify `TenantManager.claim` to try pool first, fall back to CRIU paths
- Add `injectOverlay` to `TenantDataStore`
- Wire `replenish` into claim and release paths
- Validate with fake runtime + integration tests

### Phase 2 — Remove CRIU

- Delete `GoldenCreator`, `SnapshotManager`, `hibernate()`, `snapshot()`, `restore()`
- Remove snapshot DB writes (keep table + data for rollback safety until confirmed stable)
- Remove `BOILERHOUSE_CRIU_AVAILABLE` conditionals
- Simplify `Runtime` interface
- Update Podman runtime (remove crun/CRIU requirements from docs and daemon setup)
- Update Kubernetes runtime (was already CRIU-free; remove dead code paths)
- Drop `snapshots` table in a follow-up migration once confirmed stable
- Dashboard: remove `SnapshotList` page, snapshot nav entry, golden snapshot tree in
  `WorkloadList`, snapshot metrics sections in `MetricsPage`, golden activity colouring
- Dashboard: update workload "not ready" message, add pool depth/acquire latency metrics,
  update claim source labels to `pool`/`pool+data`

### Phase 3 — Tuning

- Instrument pool depth as a metric (Grafana dashboard panel)
- Alert when pool depth drops to zero (pool exhausted, falling back to cold boot)
- Tune pool size per workload based on observed claim rate
- Consider pool pre-warming on API startup for high-priority workloads

---

## Open Questions

1. **Pool size default**: 3 is a starting point. Should it be configurable via env var as a
   global override in addition to per-workload config?

2. **Overlay injection atomicity**: If the container crashes mid-inject, the overlay may be
   partially applied. Should injection happen in a temp directory with an atomic rename, or is a
   retry-on-next-claim sufficient?

3. **Pool instance resource cost**: Warm containers consume memory and CPU while idle. Need to
   validate that `pool.size * resource_limits` fits within node capacity alongside active
   instances. The existing `ResourceLimiter` should count pool instances against `MAX_INSTANCES`.

4. **Multi-node**: In a multi-node setup, each node maintains its own pool. The claim endpoint
   must route to a node that has a warm instance available (or accept a cold boot). This is out
   of scope for now but the pool status column enables future node-aware routing.

5. **Workload updates**: When a workload image is updated, the existing pool is stale. `drain()`
   destroys all ready pool instances; `prime()` refills with the new image. Need to handle
   in-flight claimed instances gracefully (let them finish, they're already running old image).

---

## Future Work: Claim Queuing Under Resource Pressure

Out of scope for this plan, but closely related.

### The Problem

A node has a hard capacity limit (`MAX_INSTANCES`). Pool instances count against this limit.
When the node is full (all capacity consumed by active tenant instances + warming pool
instances), `acquire()` cannot start new instances to replenish, and the pool drains to zero.
The next tenant claim has nowhere to go.

Today, `ResourceLimiter` rejects requests when at capacity with a FIFO queue that times out.
With hot-pooling, the dynamics change: pool instances compete with active instances for the
same capacity. Under sustained load, the pool will be permanently empty and every claim becomes
a queue wait for a slot to free up (i.e. another tenant releasing/timing out).

### How It Relates to Hot-Pooling

The pool and the queue are two sides of the same coin:

- **Pool** absorbs burst demand — pre-created instances serve claims instantly
- **Queue** absorbs sustained overload — when demand exceeds capacity, claims wait

The pool naturally degrades into the queue case. When pool is full and node has spare capacity,
claims are instant. When pool drains and node is at capacity, claims block until a slot opens.
`acquire()` already handles the "wait for a warming instance" case — queuing extends this to
"wait for capacity to become available, then start an instance and wait for it to warm".

### What Needs to Be Built

1. **Capacity-aware `acquire()`**: When the node is at capacity, `acquire()` should not
   immediately fail. Instead it should enqueue the claim and resolve when capacity becomes
   available (another instance is destroyed). This is a natural extension of the current
   `acquire()` semantics — it already waits for warming instances, it just also needs to wait
   for capacity.

2. **Claim queue per workload**: FIFO queue of pending `acquire()` calls. When an instance is
   destroyed and capacity frees up, the next queued claim gets a new pool instance started for
   it. The queue should be bounded (max queue depth) to avoid unbounded memory growth.

3. **Adapter-level backpressure**: Trigger adapters (WhatsApp, Slack, etc.) need to handle the
   case where the claim takes a long time to fulfil. For WhatsApp specifically:
   - Send an immediate acknowledgement ("Setting things up, one moment...") so the user
     knows their message was received
   - Hold the claim in flight until `acquire()` resolves
   - Respond with the actual container output once ready
   - Respect a timeout — if the queue wait exceeds a threshold (e.g. 60s), respond with
     a "busy, try again shortly" message rather than leaving the user hanging

4. **Pool size vs active capacity budgeting**: The pool target size should be treated as a
   *reservation* against node capacity, not just a target. For example, if `MAX_INSTANCES=20`
   and `pool.size=3`, the pool reserves 3 slots, leaving 17 for active tenants. When all 17
   active slots are full, the pool still has 3 warm instances ready. When those 3 are claimed
   and the pool tries to replenish, it hits the capacity wall — this is exactly when queuing
   kicks in. The reservation ensures the pool doesn't get starved by active instances filling
   all capacity.

5. **Observability**: Queue depth and wait time as metrics. Alert when queue depth exceeds a
   threshold (signals the node is undersized or needs horizontal scaling).

---

## Task Plan

### Phase 1 — Hot-Pooling alongside CRIU

#### 1.1 DB: add `poolStatus` column to instances table

Add `poolStatus` column to the `instances` table in `packages/db/src/schema.ts` and generate a migration.

```typescript
poolStatus: text("pool_status").$type<"warming" | "ready" | "acquired" | null>()
```

**TDD tests (write first):**
- `poolStatus` defaults to `null` on insert
- `poolStatus` can be set to `"warming"`, `"ready"`, `"acquired"`
- `poolStatus` can be set back to `null`
- Querying instances by `poolStatus = "ready"` returns only ready pool instances
- Existing instance tests still pass (column is nullable, no breakage)

---

#### 1.2 Core: add `pool` config to workload schema

Add optional `pool` block to the workload TypeBox schema in `packages/core/src/workload.ts`.

```typescript
pool: Type.Optional(Type.Object({
  size: Type.Number({ default: 3 }),
  max_fill_concurrency: Type.Number({ default: 2 }),
}))
```

**TDD tests (write first):**
- Workload without `pool` field is valid and `pool` is `undefined`
- Workload with `pool: { size: 5 }` parses correctly; `max_fill_concurrency` defaults to `2`
- Workload with `pool: { size: 0 }` is valid (edge case: no pool)
- Invalid values (negative size, non-integer) are rejected by schema validation
- Existing workload parse tests still pass

---

#### 1.3 Core: add `stdin` support to `Runtime.exec`

Extend the `exec` method in `packages/core/src/runtime.ts` to accept an optional `stdin` stream, needed for overlay injection.

```typescript
exec(handle: InstanceHandle, command: string[], options?: { stdin?: NodeJS.ReadableStream }): Promise<ExecResult>
```

Update `FakeRuntime` to accept and handle the new parameter.

**TDD tests (write first):**
- `exec` without `stdin` option still works (backwards compatible)
- `FakeRuntime.exec` with `stdin` option records that stdin was provided
- `ExecResult` is returned correctly regardless of stdin presence

---

#### 1.4 API: add `injectOverlay` and `extractOverlay` to `TenantDataStore`

Add two new methods to `apps/api/src/tenant-data.ts` that operate on a running container via `runtime.exec`.

```typescript
async injectOverlay(handle: InstanceHandle, tenantId: TenantId, workloadId: WorkloadId): Promise<void>
// No-op if tenant has no stored overlay.
// Otherwise: stream tar.gz from disk → runtime.exec(handle, ["tar", "-xz", "-C", "/"], { stdin })

async extractOverlay(handle: InstanceHandle, tenantId: TenantId, workloadId: WorkloadId): Promise<void>
// No-op if workload has no overlay_dirs.
// Otherwise: exec tar -cz overlay_dirs → save stdout buffer to storage
```

**TDD tests (write first):**
- `injectOverlay` is a no-op when tenant has no stored overlay
- `injectOverlay` calls `runtime.exec` with `tar -xz -C /` and pipes the overlay tar as stdin
- `injectOverlay` resolves without error on successful exec
- `extractOverlay` is a no-op when workload has no `filesystem.overlay_dirs`
- `extractOverlay` calls `runtime.exec` with `tar -cz <dirs>` and saves the stdout buffer
- `extractOverlay` overwrites any previously stored overlay for the tenant

---

#### 1.5 API: implement `PoolManager`

Create `apps/api/src/pool-manager.ts`.

```typescript
class PoolManager {
  // Start one instance, run health checks, transition workload → "ready",
  // leave instance in pool as "ready". Replaces GoldenCreator as the workload readiness gate.
  async prime(workloadId: WorkloadId): Promise<void>

  // Atomically take one instance from the pool. Prefers ready instances;
  // awaits a warming instance if none are ready; starts a new one if pool is empty.
  // Always returns a handle — never returns null.
  async acquire(workloadId: WorkloadId): Promise<InstanceHandle>

  // Start enough new instances to reach target pool size, up to max_fill_concurrency in parallel.
  // Runs in the background; does not block the claim path.
  async replenish(workloadId: WorkloadId): Promise<void>

  // Destroy all warming and ready pool instances for a workload (e.g. image update).
  async drain(workloadId: WorkloadId): Promise<void>
}
```

**TDD tests (write first)** — use `FakeRuntime` + `createTestDatabase`:
- `prime()` creates one instance with `poolStatus = "ready"` and transitions workload to `"ready"`
- `prime()` destroys the instance and throws if health checks fail
- `acquire()` returns the single ready instance and sets its `poolStatus = "acquired"`
- `acquire()` waits for a warming instance when no ready instances exist
- `acquire()` starts a new instance when pool is completely empty
- `acquire()` is safe under concurrent callers (two simultaneous acquires get two different instances)
- `replenish()` fills pool from 1 to target size (default 3)
- `replenish()` respects `max_fill_concurrency` (starts at most N in parallel)
- `replenish()` is a no-op when pool is already at target size
- `drain()` destroys all warming and ready instances
- `drain()` does not destroy acquired or active instances

---

#### 1.6 API: update `TenantManager.claim` to use pool first

Modify `apps/api/src/tenant-manager.ts` to try `PoolManager.acquire()` before falling back to the existing CRIU restore hierarchy.

```typescript
async claim(tenantId, workloadId): Promise<ClaimResult> {
  // 1. Return existing active claim (unchanged)
  const existing = await this.findActiveClaim(tenantId)
  if (existing) return { source: "existing", ...existing }

  // 2. Acquire from pool — always returns an instance
  if (this.poolManager) {
    const instance = await this.poolManager.acquire(workloadId)
    await this.tenantData.injectOverlay(instance, tenantId, workloadId)
    await this.activateClaim(tenantId, instance)
    this.poolManager.replenish(workloadId)  // fire-and-forget
    const hasData = await this.tenantData.hasOverlay(tenantId, workloadId)
    return { source: hasData ? "pool+data" : "pool", endpoint: ... }
  }

  // 3. Existing CRIU hierarchy (unchanged, as fallback while transitioning)
  ...
}
```

**TDD tests (write first):**
- `claim()` uses `poolManager.acquire()` when pool is configured
- `claim()` calls `injectOverlay` after acquiring from pool
- `claim()` returns `source: "pool"` when tenant has no stored overlay
- `claim()` returns `source: "pool+data"` when tenant has a stored overlay
- `claim()` calls `replenish()` fire-and-forget after acquiring
- `claim()` still returns existing active claim when one exists (pool not consulted)
- When `poolManager` is absent, falls back to CRIU hierarchy unchanged

---

#### 1.7 API: wire `replenish` and `extractOverlay` into release path

Update `TenantManager.release()` and the workload registration path.

- `release()`: call `tenantData.extractOverlay()` before destroying, then `poolManager.replenish()` after (fire-and-forget)
- Workload registration: call `poolManager.prime()` instead of `goldenCreator.create()`

**TDD tests (write first):**
- `release()` calls `extractOverlay` before destroying instance
- `release()` calls `poolManager.replenish()` after destroy
- `release()` does not call `snapshot()` or `hibernate()` when pool is active
- Workload registration triggers `poolManager.prime()` (not `goldenCreator`)
- `prime()` failure on workload registration leaves workload in non-ready state

---

### Phase 2 — Remove CRIU

#### 2.1 Remove `GoldenCreator` and `SnapshotManager`

**Delete:**
- `apps/api/src/golden-creator.ts` + `golden-creator.test.ts`
- `apps/api/src/snapshot-manager.ts` + `snapshot-manager.test.ts`

**Update:**
- Remove from `createApp()` deps and `RouteDeps` interface
- Remove snapshot-related API routes (if any)
- Keep `snapshots` DB table and data as read-only (stop writing; leave for rollback safety)

**TDD tests (write first):**
- Workload reaches `"ready"` via `PoolManager.prime()` — no snapshot row written
- API returns 404 for snapshot endpoints (if they existed)

---

#### 2.2 Remove `hibernate()`, `snapshot()`, `restore()` from `Runtime`

**`packages/core/src/runtime.ts` — remove:**
- `snapshot(handle): Promise<SnapshotRef>`
- `restore(ref, instanceId, options?): Promise<InstanceHandle>`
- `capabilities: RuntimeCapabilities` (and the `RuntimeCapabilities` type)

**Also remove:**
- `BOILERHOUSE_CRIU_AVAILABLE` env var and all conditional logic
- `InstanceManager.hibernate()`
- `snapshotLocks` map in `TenantManager`
- `lastSnapshotId` reads/writes on tenant rows
- CRIU fallback in `TenantManager.claim`

**TDD tests (write first):**
- `FakeRuntime` has no `snapshot` or `restore` methods (compile-time)
- `InstanceManager` has no `hibernate()` method
- `TenantManager.claim` never calls `snapshot()` or `restore()`
- `BOILERHOUSE_CRIU_AVAILABLE=true` has no effect — no code paths check it
- All existing tests pass without the env var set

---

#### 2.3 Dashboard: remove snapshot UI

**Remove:**
- `SnapshotList.tsx` page, `/entities/snapshots` route, `Camera` nav icon
- `SnapshotSummary` type and `fetchSnapshots()` in `api.ts`
- `GoldenSnapshotNode` type and golden snapshot tree rendering in `WorkloadList.tsx`
- Snapshot metrics in `MetricsPage.tsx` (golden queue depth, snapshot creates, disk usage)
- Golden activity colouring in `ActivityLog.tsx`

**TDD tests (write first):**
- `app.tsx` routes do not include `/entities/snapshots`
- `api.ts` does not export `fetchSnapshots` or `SnapshotSummary`
- `WorkloadList.tsx` renders without golden nodes or yellow labels
- `MetricsPage.tsx` renders without snapshot metrics sections
- `ActivityLog.tsx` applies no golden colouring to any event type

---

#### 2.4 Dashboard: add pool-aware UI

**Changes:**
- `WorkloadDetail.tsx` — change not-ready message to "claims are disabled until the pool has warmed its first instance"
- `MetricsPage.tsx` — add pool metrics: depth per workload, replenish rate, acquire latency (`"pool"` vs `"pool+data"`)
- `ActivityLog.tsx` — update claim source labels: `"pool"` and `"pool+data"` (replacing snapshot/golden labels)
- `api.ts` — add `fetchPoolStatus()` returning pool depth per workload

**TDD tests (write first):**
- `WorkloadDetail` renders "until the pool has warmed" message when workload is not ready
- `MetricsPage` renders pool depth section with per-workload breakdown
- `ActivityLog` displays `"pool"` and `"pool+data"` source labels
- `fetchPoolStatus()` parses pool depth response correctly

---

### Phase 3 — Tuning

#### 3.1 Observability: pool depth metric and Grafana panel

- Add `pool_depth` observable gauge (count of `poolStatus = "ready"` instances per workload)
- Add `pool_acquire_source` counter with label `source: "ready" | "warming" | "cold"`
- Add "Pool" row to `deploy/grafana/boilerhouse.json` with pool depth time-series and acquire source breakdown

**TDD tests (write first):**
- Pool depth gauge emits one observation per workload with the correct count
- Pool depth gauge emits `0` when pool is empty (not omitted)
- `pool_acquire_source` counter increments for each acquire with the correct label
- Grafana dashboard JSON contains panels with titles "Pool depth" and "Acquire source"

---

#### 3.2 Observability: alert when pool depth hits zero

Add Prometheus alerting rule:

```yaml
- alert: PoolExhausted
  expr: pool_depth == 0
  for: 30s
  labels: { severity: warning }
  annotations:
    summary: "Pool exhausted for workload {{ $labels.workload_id }}"
```

**TDD tests (write first):**
- Alert rule YAML is valid Prometheus alerting rule syntax (`promtool check rules`)
- Alert fires when `pool_depth == 0` for 30s
- Alert does not fire when `pool_depth > 0`

---

#### 3.3 API startup: pre-warm pools for all ready workloads

On API startup, call `poolManager.replenish(workloadId)` (fire-and-forget) for each workload in `"ready"` state, so warm instances are available immediately after a restart.

**TDD tests (write first):**
- On startup with two ready workloads, `replenish()` is called once per workload
- On startup with no ready workloads, `replenish()` is not called
- Workloads in `"pending"` or `"error"` state are not pre-warmed
- Pre-warm is fire-and-forget: startup does not await replenish completion
