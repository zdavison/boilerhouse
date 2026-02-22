# Refactor A — Code Review Findings

Senior TypeScript engineering review of the full codebase. Issues are grouped by severity.

---

## Bugs (Actual Behavioral Problems)

### 1. Idle monitor is wired to a no-op — tenants never auto-release

**`apps/api/src/server.ts:140-142`**

```ts
idleMonitor.onIdle(async (instanceId, action) => {
    console.log(`Idle timeout: instance=${instanceId} action=${action}`);
});
```

The idle monitor fires correctly (timers work, `fireIdle()` triggers) but the handler just logs. `tenantManager.release()` is never called. Idle timeout does nothing.

The root cause is an API mismatch: `IdleMonitor` surfaces `(instanceId, action)` but `TenantManager.release()` needs a `tenantId`. Fix requires either looking up the tenantId from the instanceId inside the handler, or changing `IdleMonitor.watch()` to also track the tenantId.

---

### 2. Node ID regenerated on every restart — breaks recovery

**`apps/api/src/server.ts:79-98`**

```ts
const nodeId = generateNodeId();           // always a fresh random ID
...
const existingNode = db.select().from(nodes).get();
if (!existingNode) {
    db.insert(nodes).values({ nodeId, ... }).run();
}
// server proceeds with the NEW nodeId regardless
```

On restart a new `nodeId` is generated, but the DB node row still holds the old one. All existing instances, snapshots, and tenants reference the old nodeId. `recoverState()` queries `instances.nodeId = nodeId` with the new ID — finds nothing — so orphaned VMs are not cleaned up. `snapshotManager.getGolden(workloadId, nodeId)` also finds nothing, so workloads appear to have no golden snapshot.

Fix: persist the node ID (e.g. in a file alongside the DB) and load it on startup instead of generating a fresh one.

---

### 3. `nodeId: undefined!` anti-pattern

**`apps/api/src/server.ts:58`**

```ts
const runtimeConfig: FirecrackerConfig = {
    nodeId: undefined!, // Set after nodeId generation below
    ...
};
```

This is a factually false non-null assertion. If anything reads `runtimeConfig.nodeId` before line 80 it gets `undefined` with no type error. Fix: build the config object after `nodeId` is available.

---

### 4. TAP recovery not wired in non-jailer (dev) mode

**`apps/api/src/server.ts:145-176`**

```ts
const recoveryOptions: RecoveryOptions = {};
if (useJailer) {
    // sets up netns + jail cleanup
    // listTaps / destroyTap are NEVER set for either mode
}
```

`recoveryOptions.listTaps` and `destroyTap` are never populated in `server.ts`. Orphaned TAP devices from a crashed process are not cleaned up on restart in dev mode.

---

### 5. EventBus not emitted for all instance state changes — ResourceLimiter never fires

`ResourceLimiter` watches for `instance.state` events to release capacity:

```ts
// server.ts:130-137
eventBus.on((event) => {
    if (event.type === "instance.state" &&
        (event.status === "destroyed" || event.status === "hibernated")) {
        resourceLimiter.release(nodeId);
    }
});
```

`InstanceManager` never emits events — only the route handlers manually emit them after calling manager methods. When the idle monitor path is fixed (Bug 1) it will call `tenantManager.release()` → `instanceManager.hibernate()` with no route involved, so no event fires and the capacity slot is never freed. The resource limiter would fill permanently during idle-triggered releases.

Fix: emit `instance.state` events from within `InstanceManager` directly, not from route handlers.

---

## Architecture Issues

### 6. Actor classes — unnecessary abstraction with double DB reads

The four Actor classes (`InstanceActor`, `TenantActor`, `SnapshotActor`, `WorkloadActor`) are created ephemerally inline immediately after the manager already fetched the same row. Each one then re-fetches current status:

```ts
// instance-manager.ts:73-92
const row = this.db.select().from(instances)...get(); // fetch 1
const actor = new InstanceActor(this.db, instanceId);
actor.send("destroy"); // actor.status → fetch 2 (same row)
```

The actor abstraction makes sense for long-lived, cached objects. As ephemeral one-shot wrappers they add indirection with no benefit. A standalone `applyTransition(db, id, currentStatus, event)` function that accepts the already-fetched status would be simpler and eliminate the extra read.

---

### 7. `TenantManager.claim()` has 3× copy-pasted restore branches

Steps 2, 3, and 4 of `claim()` are structurally identical — only `ref` and `source` differ:

```ts
const handle = await this.instanceManager.restoreFromSnapshot(ref, tenantId);
this.upsertTenant(tenantId, workloadId, handle.instanceId);
this.updateInstanceClaimed(handle.instanceId);
const endpoint = await this.runtime.getEndpoint(handle);
this.logClaim(tenantId, handle.instanceId, workloadId, source);
this.startIdleWatch(handle.instanceId, workloadId);
return { tenantId, instanceId: ..., endpoint, source, latencyMs: ... };
```

Should be extracted to `private async restoreAndClaim(ref, tenantId, workloadId, source, start)`.

---

### 8. `getSnapshotRef` runtimeMeta validation duplicated

The same runtimeMeta validation appears in two places:

- `tenant-manager.ts:252-258`
- `snapshot-manager.ts:174-181`

```ts
if (!meta ||
    typeof meta.runtimeVersion !== "string" ||
    typeof meta.cpuTemplate !== "string" ||
    typeof meta.architecture !== "string") {
    return null;
}
```

Should be extracted to a shared `rowToSnapshotRef(row): SnapshotRef | null` helper, most naturally in `@boilerhouse/db`.

---

### 9. `TenantManager` constructor takes 8 parameters

```ts
constructor(
    private readonly instanceManager: InstanceManager,
    private readonly snapshotManager: SnapshotManager,
    private readonly db: DrizzleDb,
    private readonly activityLog: ActivityLog,
    private readonly runtime: Runtime,     // only used for getEndpoint()
    private readonly nodeId: NodeId,
    private readonly tenantDataStore: TenantDataStore,
    private readonly idleMonitor?: IdleMonitor,
)
```

`runtime` is only used for `getEndpoint()` in `claim()`. Adding `getEndpoint(instanceId: InstanceId)` to `InstanceManager` removes one dependency from `TenantManager`.

---

### 10. Two-phase actor transitions without transactions leave entities in broken intermediate states

In `tenant-manager.ts:release()`:

```ts
actor.send("release");              // DB: tenant → "releasing"
await instanceManager.hibernate();  // async — can throw
actor.send("hibernated");           // DB: tenant → "released"
```

If the async operation throws or the process crashes, the tenant is left in `releasing` with no recovery path. Same pattern in `upsertTenant()` with `claim` → `claimed`. Options:

- Wrap the full operation in a SQLite transaction so the intermediate state only commits on success.
- Add recovery events to state machines for each intermediate state so that `recoverState()` can handle them.

---

### 11. `@boilerhouse/core` is a kitchen sink

The package contains: branded IDs, state machine infrastructure, 5 entity state machines, the `Runtime` interface, `FakeRuntime`, the TypeBox workload parser, image path resolution, and snapshot types. Items that have no conceptual connection to each other are colocated.

Suggested split:

- `@boilerhouse/core` — IDs, state machines, domain types
- `@boilerhouse/runtime` — `Runtime` interface, `FakeRuntime`, `SnapshotRef`, `Endpoint`

---

## Code Quality

### 12. Routes bypass Elysia's schema validation

Throughout routes:

```ts
const { workload: workloadName } = body as { workload: string };
const tenantId = params.id as TenantId;
const status = query.status as InstanceStatus | undefined;
```

Elysia provides first-class TypeBox body/query validation via `t.Object()`. These casts skip it entirely. Malformed request bodies don't get clean 400 errors — they silently produce wrong types downstream. Routes should declare schemas in the Elysia method call so validation is automatic and type-safe without casts.

---

### 13. `ResourceLimiter.countActive()` fetches all columns to count rows

**`resource-limits.ts:103-114`**

```ts
const rows = this.db.select().from(instances).where(...).all();
return rows.length;
```

Should use `select({ count: count() })` from drizzle-orm to do this at the DB level.

---

### 14. `InstanceHandle` construction is scattered knowledge

Building an `InstanceHandle` requires knowing that `status === "active"` means `running: true`. This logic is repeated in multiple places:

```ts
// instance-manager.ts (×2)
const handle: InstanceHandle = { instanceId, running: row.status === "active" };

// routes/instances.ts
const handle = { instanceId, running: true };  // unconditionally assumes running
```

The third case (`running: true` unconditionally) is incorrect for non-active instances. Extract a `makeHandle(row: InstanceRow): InstanceHandle` factory.

---

### 15. `TenantDataStore._workloadId` parameter is unused in `restoreOverlay`

**`tenant-data.ts:36`**

```ts
restoreOverlay(tenantId: TenantId, _workloadId: WorkloadId): string | null {
```

`workloadId` is encoded in the stored path and the full path is retrieved from `dataOverlayRef`. The parameter is silently ignored. Either remove it from the signature, or use it to verify the stored path for defensive correctness.

---

### 16. `NetnsManager.destroy()` API requires full config for orphan cleanup

**`server.ts:152-163`**

```ts
recoveryOptions.destroyNetns = async (nsName) => {
    await netnsManager.destroy({
        nsName,
        nsPath: `/var/run/netns/${nsName}`,
        tapName: "tap0",
        tapIp: "",
        tapMac: "",       // empty strings to satisfy interface
        vethHostIp: "",
        guestIp: "",
        vethHostName: "",
    });
};
```

Passing empty strings to satisfy a required interface is an abstraction leak. `NetnsManager.destroy()` presumably only uses `nsName` and `nsPath` for cleanup. The interface should split `create(config)` from `destroy(nsName: string)`.

---

### 17. State machine event naming is inconsistent

Instance events mix past tense (notifications) and imperatives (commands):

| Event       | Form        |
|-------------|-------------|
| `started`   | past tense  |
| `hibernate` | imperative  |
| `destroy`   | imperative  |
| `restore`   | imperative  |
| `destroyed` | past tense  |

Pick one convention throughout all state machines. XState convention uses imperative commands for all events.

---

### 18. `GoldenCreator` has no workload deduplication in queue

Enqueueing the same workload twice (e.g. two rapid `POST /workloads` calls) processes both sequentially, creating two golden snapshots. The second overwrites the first via delete+insert semantics in `createGolden`. Correct but wasteful. A `Set<WorkloadId>` of queued IDs would prevent this.

---

### 19. Workload defaults applied via mutation before validation

**`packages/core/src/workload.ts`**

`applyDefaults()` mutates the raw `Record<string, unknown>` before `Value.Check()` runs. TypeBox provides `Value.Default(schema, raw)` for this purpose. The current approach works but any future schema field with a default requires updating `applyDefaults()` manually rather than being declared in the schema.

---

### 20. XState is listed in `bun.lock` but never used

`bun.lock` contains `xstate@5.28.0` and there is a `docs/plans/xstate.md` design doc, but the implementation uses the custom `createMachine()` in `packages/core/src/state-machine.ts`. Remove the XState package.

---

## What's Working Well

- **Branded ID types** — `$type<NodeId>()` on Drizzle columns with `unique symbol` branding; type safety propagates correctly throughout.
- **Custom Drizzle column types** — `timestamp` and `jsonObject<T>` in `packages/db/src/columns.ts` are clean and well-tested.
- **State machine infrastructure** — `createMachine()` in `@boilerhouse/core` is pure, composable, and the `Guard` system is a useful extension point.
- **FakeRuntime** — well-designed test double with configurable latency and failure injection; the test infrastructure built on top is comprehensive.
- **Plugin-per-resource in Elysia** — `routes/{instances,tenants,...}.ts` is the right level of granularity.
- **Recovery on startup** — production-minded; `RecoveryReport` return type makes recovery observable and testable.
- **TOML workload definitions** — clean config-as-code with solid TypeBox validation.
- **Claim hierarchy** — the four-level fallback (existing → snapshot → golden+data → golden) is clear and well-commented; `ClaimSource` in the response is excellent for observability.
- **ActivityLog with auto-pruning** — practical and correct.

---

## Recommended Fix Order

| Priority | Issue                                                       | Impact                              |
|----------|-------------------------------------------------------------|-------------------------------------|
| 1        | Idle monitor no-op (§1)                                     | Feature completely non-functional   |
| 2        | Node ID regenerated on restart (§2)                         | Recovery broken after first restart |
| 3        | EventBus not emitted from managers (§5)                     | ResourceLimiter silently fills up   |
| 4        | TAP recovery not wired (§4)                                 | Dev-mode resource leak on restart   |
| 5        | `nodeId: undefined!` (§3)                                   | Latent crash risk                   |
| 6        | Route schema validation bypassed (§12)                      | Security / correctness              |
| 7        | Claim() duplication (§7)                                    | Maintainability                     |
| 8        | `getSnapshotRef` duplicated (§8)                            | Maintainability                     |
| 9        | Actor double DB reads (§6)                                  | Performance / clarity               |
| 10       | No transactions on two-phase transitions (§10)              | Data integrity under failure        |

---

## State Machine Architecture Critique

The current approach: **state machines as pure status validators.** They receive a current state and an event, return the next state (or throw), and nothing else. The Actor classes wire this to the DB. That's the entire scope.

### What the machines do well

The core infrastructure is genuinely solid. `createMachine()` produces a pure function — no I/O, no side effects, trivially testable. The `Guard` extension point is a clean design. Using TypeBox schemas for status/event types means they serve dual purpose as runtime validators and TypeScript types. The transition maps are readable at a glance.

### Structural problems

**The machines and their consequences are not connected.**

Every state transition in this system involves three independent steps:

1. Validate the transition (machine)
2. Write the new status to the DB (Actor)
3. Emit the domain event (EventBus, manually in route handlers)

Nothing enforces that all three happen. If you call `instanceManager.hibernate()` from the idle monitor (once that's wired), step 3 never runs because there's no route handler to emit it. The `ResourceLimiter` then never frees the slot. This is the root cause of Bug §5 — the machine validated correctly, the DB was updated correctly, but the system is still broken because the notification was forgotten.

**Two-phase transitions are a design smell.**

Multiple callsites do:

```ts
actor.send("release");         // DB: tenant → "releasing"
await instanceManager.hibernate();
actor.send("hibernated");      // DB: tenant → "released"
```

The machine models `releasing` as a meaningful intermediate state, but there's no recovery event for it. If the process crashes between the two sends the tenant is stuck in `releasing` forever. The state machine expresses a concurrency model (`releasing` = "operation in progress") that the infrastructure doesn't support resuming from. This is the machines describing more than the system can actually guarantee.

**The guard system is completely dormant.**

`createMachine()` supports guards, but none of the five entity machines define any. Business rules that should be encoded as guards currently live as scattered pre-flight checks in manager methods, or aren't encoded anywhere at all.

**The `can()` method exists and is never called.**

`Machine<S,E,Ctx>` exposes `can(current, event): boolean` but it isn't used anywhere. Pre-flight checks in managers re-fetch state from the DB and call `actor.validate()` (which hits the DB again), rather than calling `machine.can()` against already-fetched data.

**The `Ctx` generic parameter is defined and never used.**

`createMachine<S, E, Ctx>()` has a context parameter for guards, but all machines are created without it. Guards that required database context (e.g. "can only hibernate if no in-progress snapshots") can't be expressed in the machine — they live outside it, in manager pre-flight code.

**The tenant machine's intermediate states can't be recovered.**

```
idle → [claim] → claiming → [claimed] → active
                           → [claim_failed] → idle
```

`claiming` and `releasing` are transient DB states. Instance recovery explicitly handles `starting` by marking it `destroyed`. Tenant `claiming` and `releasing` are not handled in `recoverState()` — tenants can be stranded in these states after a crash with no escape. If the intermediate states can't be recovered they are providing false confidence.

---

### Should we lean in more?

**No — but the connective tissue around the machines needs to be tightened.**

The machines-as-pure-validators approach is correct for this domain. XState-style machines that own their side effects (spawning async actors, emitting events, managing timers) would trade the current simplicity for significant complexity. For a system where the DB is the source of truth and Bun SQLite is synchronous, pure transition functions are the right fit.

What needs to change is not the machines themselves — it's what surrounds them.

**1. The Actor should own the full "transition + notify" pair.**

Actors currently do transition + DB write. Event emission is manual, separate, and forgettable. The Actor (or a replacement function) should accept an optional EventBus and emit automatically on successful transition, making "DB updated" and "event emitted" a single indivisible operation:

```ts
// Instead of: actor.send("hibernated") + manual eventBus.emit({ type: "instance.state", ... })
applyInstanceTransition(db, instanceId, "hibernated", eventBus);
// → writes DB status, emits instance.state event atomically
```

**2. Use guards to encode business rules centrally.**

Rules currently scattered as manager pre-flight checks belong in the machine definitions. Any caller — route handler, recovery process, idle monitor — then gets the same checks automatically without having to know to invoke them.

**3. Eliminate two-phase transitions or make the intermediates recoverable.**

Either:
- Wrap the full operation in a SQLite transaction so the intermediate state is never committed unless both steps succeed, or
- Add recovery events to the machines (`recover_releasing`, `recover_claiming`) and handle them explicitly in `recoverState()`

The current situation — intermediates exist in the machine but recovery ignores them — is the worst of both worlds.

**4. Use `can()` for pre-flight checks instead of re-fetching status.**

When a manager already has the DB row, call `machine.can(row.status, event)` directly rather than creating an Actor that fetches it again. The second DB read is unnecessary and the `can()` method exists precisely for this purpose.

---

## FirecrackerRuntime — Split Jailer Mode into a Separate Class

### The conditional count

`isJailerMode` controls behaviour in **7 different places** across the public interface:

| Method | Branch |
|---|---|
| `constructor` | creates `NetnsManagerImpl` + `JailPreparer` if jailer |
| `create()` | dispatches to `createDirect` or `createJailed` |
| `destroy()` | entirely different teardown paths (TAP vs netns+jail) |
| `snapshot()` | dispatches to `snapshotDirect` or `snapshotJailed` |
| `restore()` | dispatches to `restoreDirect` or `restoreJailed` |
| `getEndpoint()` | `netnsHandle.guestIp` vs derived TAP IP |
| `available()` | also checks `jailer.jailerPath` binary |

Each dispatched private method is a completely separate implementation — there is no shared logic inside the `Direct`/`Jailed` method pairs. They are parallel implementations that happen to live in the same class.

### `ManagedInstance` is a polluted union

```ts
interface ManagedInstance {
    process: FirecrackerProcess | JailedProcess;
    tapDevice?: TapDevice;       // dev only — always undefined in jailer mode
    netnsHandle?: NetnsHandle;   // jailer only — always undefined in dev mode
    jailPaths?: JailPaths;       // jailer only — always undefined in dev mode
    uid?: number;                // jailer only — always undefined in dev mode
}
```

Four optional fields that are actually required — just for different modes. This forces non-null assertions throughout: `managed.netnsHandle!`, `managed.jailPaths!`, `this.netnsManager!`, `this.jailPreparer!`, `this.config.jailer!`. The process must also be explicitly cast to the right type in `destroy()`:

```ts
await (managed.process as JailedProcess).kill();
// vs
(managed.process as FirecrackerProcess).kill();
```

The type system has given up. It knows `process` is one of two types but can't tell you which.

### `FirecrackerConfig` has the same problem

```ts
export interface FirecrackerConfig {
    tapManager?: TapManager;  // required when jailer is not set
    jailer?: JailerConfig;    // required when tapManager is not set
}
```

The mutual exclusion is enforced at runtime with a constructor throw. Two separate config types enforce it at compile time — invalid configs become impossible to construct.

### What's actually shared

Genuinely shared across both modes:

- `start()`, `list()`, `exec()` — identical
- The CoW rootfs copy at the start of `restore()`
- Module-level pure functions (`buildBootArgs`, `buildEntrypointBootArgs`, `deriveGuestIp`)
- `resolveRootfsPath()`, `requireInstance()`, `copyFile()`

Everything else diverges completely.

### The right split: abstract base + two concrete classes

```
BaseFirecrackerRuntime (abstract)
├── start(), list(), exec()
├── resolveRootfsPath(), requireInstance(), copyFile()
└── shared rootfs copy logic in restore()

DevFirecrackerRuntime extends BaseFirecrackerRuntime
├── config: DevFirecrackerConfig { tapManager: TapManager, ... }
├── ManagedDevInstance { tapDevice: TapDevice, process: FirecrackerProcess }
└── create(), destroy(), snapshot(), restore(), getEndpoint(), available()

JailedFirecrackerRuntime extends BaseFirecrackerRuntime
├── config: JailedFirecrackerConfig { jailer: JailerConfig, ... }
├── ManagedJailedInstance { netnsHandle: NetnsHandle, jailPaths: JailPaths, uid: number, process: JailedProcess }
└── create(), destroy(), snapshot(), restore(), getEndpoint(), available()
```

`DevFirecrackerRuntime` is named explicitly to signal it is not production-safe (no isolation, no namespace separation, TAP devices on the host network).

The managed instance types become concrete and fully required in each subclass — no optionals, no casts, no `!` assertions.

### The recovery gap fixes itself

The current bug (TAP devices not cleaned up in dev mode on restart) exists because `server.ts` manually wires recovery callbacks and only wired the jailer ones. Each runtime class can instead expose its own cleanup:

```ts
abstract cleanupOrphans(activeInstanceIds: Set<string>): Promise<RecoveryReport>
```

Recovery calls the runtime's own method. The runtime knows its own cleanup needs — `server.ts` no longer has to.

### The construction site becomes explicit

Before:
```ts
if (useJailer) {
    runtimeConfig.jailer = jailerConfig;
} else {
    runtimeConfig.tapManager = new TapManager();
}
const runtime = new FirecrackerRuntime(runtimeConfig);
```

After:
```ts
const runtime = useJailer
    ? new JailedFirecrackerRuntime({ ...baseConfig, jailer: jailerConfig })
    : new DevFirecrackerRuntime({ ...baseConfig, tapManager: new TapManager() });
```

The mode decision is made once, at the construction site, rather than spread across 7 methods and 10 non-null assertions.
