# Lifecycle Hooks

## Context

We need a way to seed data and run commands during golden snapshot creation
and tenant claims. Rather than a one-off "seed" feature, we're implementing
lifecycle hooks — a general-purpose mechanism that fires at specific points
during state transitions. This plugs into the existing FSM architecture and
can be extended with new hook points later.

Hooks are TypeScript functions defined in `.workload.ts` files. They run on
Boilerhouse (not in the container) and interact with the container via a
context object (`ctx.exec()`). This gives full language power — conditionals,
loops, error handling — instead of a declarative action DSL.

## Hook Points

Two initial hook points:

- **`preSnapshot`** — after health check passes, before `runtime.snapshot()`.
  Seeds the golden image with data/state that all tenants inherit.
- **`postClaim`** — after restore + DB updates, before endpoint is returned.
  Per-tenant initialization. Context includes `tenantId` and `source`.

## Workload Config

```ts
export default defineWorkload({
  name: "openclaw",
  version: "0.2.0",
  image: { ref: "localhost/openclaw:latest" },
  resources: { vcpus: 2, memory_mb: 2048 },
  // ...existing fields...
  lifecycle: {
    async preSnapshot(ctx) {
      await ctx.exec(["sh", "-c", "rm -rf /tmp/* /var/tmp/*"]);
      await ctx.exec(["npm", "cache", "clean", "--force"]);
      ctx.log("Snapshot prep complete");
    },
    async postClaim(ctx) {
      ctx.log(`Initializing tenant ${ctx.tenantId}`);
      await ctx.exec(["node", "scripts/init-tenant.js"]);
    },
  },
});
```

## Serialization Boundary

Functions can't survive JSON serialization. The current flow is:

```
.workload.ts → resolveWorkloadConfig() → JSON → DB
```

Lifecycle functions must be stored separately from the DB config. The
approach: a `HookRegistry` holds the functions in memory, populated from
`.workload.ts` files on startup via `loadWorkloadsFromDir`.

- File-based workloads (`WORKLOADS_DIR`): have hooks (loaded on every boot)
- API-registered workloads (`POST /api/v1/workloads`): no hooks (JSON only)

This is the right boundary — hooks are code, and code lives on disk.

## Implementation Steps

### Step 1: Types

**File: `packages/core/src/workload.ts`**

Add context interfaces and the lifecycle type. These don't go in the
TypeBox schema (functions aren't JSON-serializable) — they're TypeScript-only
types on `WorkloadConfig`.

```ts
export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface HookContext {
  /** Execute a command inside the container. Throws on non-zero exit. */
  exec(command: string[]): Promise<ExecResult>;
  /** Log a message to the bootstrap log / structured logger. */
  log(message: string): void;
  /** Workload name. */
  workload: string;
}

export interface PreSnapshotContext extends HookContext {}

export interface PostClaimContext extends HookContext {
  tenantId: string;
  source: "snapshot" | "cold+data" | "golden";
}

export type PreSnapshotHook = (ctx: PreSnapshotContext) => Promise<void>;
export type PostClaimHook = (ctx: PostClaimContext) => Promise<void>;

export interface LifecycleHooks {
  preSnapshot?: PreSnapshotHook;
  postClaim?: PostClaimHook;
}
```

Add `lifecycle?: LifecycleHooks` to `WorkloadConfig` interface. Do NOT add
it to `WorkloadSchema` (TypeBox) — it's not stored in the DB.

In `resolveWorkloadConfig()`, strip `lifecycle` before validation:

```ts
// lifecycle contains functions — strip before JSON validation
const { lifecycle, ...rest } = config;
// ...use rest to build raw...
```

### Step 2: Hook registry

**New file: `apps/api/src/hook-registry.ts`**

```ts
import type { LifecycleHooks } from "@boilerhouse/core";

/**
 * In-memory registry of lifecycle hook functions, keyed by workload name.
 * Populated from .workload.ts files on startup; repopulated on every boot.
 */
export class HookRegistry {
  private readonly hooks = new Map<string, LifecycleHooks>();

  register(workloadName: string, hooks: LifecycleHooks): void {
    this.hooks.set(workloadName, hooks);
  }

  get(workloadName: string): LifecycleHooks | undefined {
    return this.hooks.get(workloadName);
  }

  has(workloadName: string): boolean {
    return this.hooks.has(workloadName);
  }

  clear(): void {
    this.hooks.clear();
  }
}
```

### Step 3: Populate registry from workload loader

**File: `packages/db/src/workload-loader.ts`**

`loadWorkloadsFromDir` already `import()`s each `.workload.ts` module and
has access to `mod.default` (the full `WorkloadConfig` including lifecycle).
Change the return type to also yield the lifecycle hooks:

```ts
export interface WorkloadLoaderResult {
  loaded: number;
  updated: number;
  unchanged: number;
  errors: Array<{ file: string; error: string }>;
  /** Lifecycle hooks extracted from loaded modules, keyed by workload name. */
  hooks: Map<string, LifecycleHooks>;
}
```

In the loop, after `resolveWorkloadConfig(mod.default)`, capture:

```ts
if (mod.default.lifecycle) {
  result.hooks.set(workload.workload.name, mod.default.lifecycle);
}
```

### Step 4: Wire registry into server startup

**File: `apps/api/src/server.ts`**

After `loadWorkloadsFromDir` returns (~line 93):

```ts
const hookRegistry = new HookRegistry();

if (workloadsDir) {
  const result = await loadWorkloadsFromDir(db, workloadsDir);
  // ...existing logging...

  // Populate hook registry from loaded modules
  for (const [name, hooks] of result.hooks) {
    hookRegistry.register(name, hooks);
  }
}
```

Pass `hookRegistry` to `SnapshotManager` (or `GoldenCreator`) and
`TenantManager`.

### Step 5: Build context and run hooks — preSnapshot

**File: `apps/api/src/snapshot-manager.ts`**

Add `hookRegistry` to constructor options. Insert between health check
(line ~119) and snapshot (line ~122):

```ts
const hooks = this.hookRegistry?.get(workload.workload.name);
if (hooks?.preSnapshot) {
  log("Running preSnapshot hook...");
  const ctx: PreSnapshotContext = {
    exec: async (command) => {
      const result = await this.runtime.exec(handle, command);
      if (result.exitCode !== 0) {
        throw new Error(
          `exec [${command.join(" ")}] exited ${result.exitCode}: ${result.stderr.slice(0, 500)}`,
        );
      }
      return result;
    },
    log,
    workload: workload.workload.name,
  };
  await hooks.preSnapshot(ctx);
  log("preSnapshot hook completed.");
}
```

On failure, the existing catch block (line 174) destroys the bootstrap
instance and re-throws. No new error handling needed.

### Step 6: Build context and run hooks — postClaim

**File: `apps/api/src/tenant-manager.ts`**

Add `hookRegistry` to constructor. In `restoreAndClaim()`, after
`updateInstanceClaimed` (line ~214), before `safeGetEndpoint` (line ~216):

```ts
const hooks = this.hookRegistry?.get(workloadConfig.workload.name);
if (hooks?.postClaim && source !== "existing") {
  this.log?.info({ tenantId, hook: "postClaim" }, "Running postClaim hook");
  const ctx: PostClaimContext = {
    exec: async (command) => {
      const result = await this.instanceManager.exec(handle, command);
      if (result.exitCode !== 0) {
        throw new Error(
          `exec [${command.join(" ")}] exited ${result.exitCode}: ${result.stderr.slice(0, 500)}`,
        );
      }
      return result;
    },
    log: (msg) => this.log?.info({ tenantId, hook: "postClaim" }, msg),
    workload: workloadConfig.workload.name,
    tenantId,
    source,
  };
  await hooks.postClaim(ctx);
}
```

Needs `InstanceManager.exec()` delegation method (same as before):
```ts
async exec(handle: InstanceHandle, command: string[]): Promise<ExecResult> {
  return this.runtime.exec(handle, command);
}
```

Note: skip postClaim for `source === "existing"` — the instance is already
running, this isn't a fresh claim.

### Step 7: E2E test helpers

**File: `apps/api/src/e2e/e2e-helpers.ts`**

Update `readFixture` to also return hooks, and `startE2EServer` to accept
and wire a `HookRegistry`. Or: create fixtures with lifecycle hooks and
register them in the E2E server setup.

## Error Handling

- **preSnapshot failure**: propagates through `createGolden()`'s existing
  catch block, which destroys the bootstrap instance. Workload transitions
  to "error" status. Hook output visible in bootstrap logs via `ctx.log()`.
- **postClaim failure**: instance remains active (already restored). Error
  propagates as 500 to the caller. Operator can investigate the running
  instance or release the tenant.
- **ctx.exec() throws on non-zero exit**: the hook author can catch this
  themselves if they want continue-on-error behavior.

## Files Modified

| File | Change |
|------|--------|
| `packages/core/src/workload.ts` | HookContext, PreSnapshotContext, PostClaimContext, LifecycleHooks types; lifecycle on WorkloadConfig; strip in resolveWorkloadConfig |
| `packages/core/src/index.ts` | Export new types |
| `apps/api/src/hook-registry.ts` | **New** — HookRegistry class |
| `packages/db/src/workload-loader.ts` | Extract lifecycle hooks from modules, return in result |
| `apps/api/src/server.ts` | Create HookRegistry, populate from loader, pass to managers |
| `apps/api/src/snapshot-manager.ts` | Accept HookRegistry, run preSnapshot hook |
| `apps/api/src/instance-manager.ts` | Add exec() delegation method |
| `apps/api/src/tenant-manager.ts` | Accept HookRegistry, run postClaim hook |

## Future Extensions

- **More hook points**: `preHibernate`, `postRestore`, `preDestroy` — add to
  LifecycleHooks interface + wire at the appropriate transition point.
- **ctx.writeFile(path, content)**: convenience on the context object,
  implemented via exec + heredoc internally.
- **ctx.copyFile(hostPath, guestPath)**: for injecting larger files.
- **ctx.env**: read-only access to workload env vars from hooks.

## Verification

1. `bun test --recursive` — existing tests still pass
2. Unit tests for hook-registry.ts
3. Test cases in snapshot-manager.test.ts for preSnapshot hooks
4. Test cases in tenant-manager.test.ts for postClaim hooks
5. Workload config with lifecycle still validates (lifecycle stripped before schema check)
6. E2E: workload with lifecycle hooks, verify hooks fire during golden creation
   and tenant claim
