# State Machines for All Entities

## Context

Every entity with a lifecycle (instances, nodes, tenants, snapshots) currently manages state
transitions via raw `.set({ status: "..." })` calls with ad-hoc or missing guards. The one
formal XState machine that exists (`instance-state.ts`) is never called outside its own tests.
This means illegal transitions silently succeed — e.g. stopping a hibernated instance,
hibernating a starting instance, destroying without checking current state.

### Decision: Drop XState, use a custom ~40-line FSM

XState (`^5.28.0`, 2.6 MB on disk) provides actors, guards, context, parallel states, and
delayed transitions — none of which we use. We call `getNextSnapshot()` once, in a function
nobody imports.

An exhaustive search of the npm ecosystem found no actively maintained library under 10KB
that provides pure functional transitions + typed guards + strong TypeScript generics:

| Library              | Pure transition fn | Guards | TS generics | Status         |
| -------------------- | ------------------ | ------ | ----------- | -------------- |
| `@xstate/fsm`        | Yes                | Yes    | Strong      | **Deprecated** |
| `robot3`             | No (needs service) | Yes    | Weak        | Active         |
| `@doeixd/machine`    | Yes                | No     | Excellent   | Active         |
| `@marianmeres/fsm`   | No (OOP)           | Yes    | Good        | Active         |
| `@fsmoothy/core`     | No (OOP)           | Yes    | Partial     | Stale          |
| `ts-state-machines`  | Yes                | No     | Good        | Abandoned      |

A custom implementation is ~40 lines, zero dependencies, perfectly typed, and exactly fits
our requirements. Smaller than any dependency we'd add.

---

## Bugs the Missing Validation Causes Today

| Operation                              | What happens                                 |
| -------------------------------------- | -------------------------------------------- |
| `stop()` on a `hibernated` instance    | Sets `stopping` → `destroyed`, skips restore |
| `hibernate()` on a `starting` instance | Snapshots a half-booted VM                   |
| `destroy()` on a `destroying` instance | Redundant runtime call, double activity log  |
| `stop()` on a `stopping` instance      | Redundant runtime call, double activity log  |
| Recovery sets `starting` → `destroyed` | Valid for recovery, but invalid per machine  |

---

## 1. Shared FSM infrastructure

**New file: `packages/core/src/state-machine.ts`**

```ts
export class InvalidTransitionError extends Error {
  constructor(
    public readonly entity: string,
    public readonly currentStatus: string,
    public readonly event: string,
  ) {
    super(`Invalid ${entity} transition: '${event}' not allowed in '${currentStatus}'`);
    this.name = "InvalidTransitionError";
  }
}

export type TransitionMap<S extends string, E extends string> =
  Record<S, Partial<Record<E, S>>>;

export type Guard<S extends string, E extends string, Ctx = undefined> =
  (current: S, event: E, ctx: Ctx) => boolean | string;

export interface MachineConfig<S extends string, E extends string, Ctx = undefined> {
  transitions: TransitionMap<S, E>;
  guards?: Partial<Record<E, Guard<S, E, Ctx>>>;
}

export function createMachine<S extends string, E extends string, Ctx = undefined>(
  entity: string,
  config: MachineConfig<S, E, Ctx>,
) {
  return {
    entity,
    config,
    transition(current: S, event: E, ctx?: Ctx): S { ... },
    can(current: S, event: E, ctx?: Ctx): boolean { ... },
  };
}
```

- `transition()` — pure `(state, event, ctx?) → state`, throws `InvalidTransitionError`
- `can()` — pure predicate, never throws
- Guards receive optional typed context (e.g. DB-derived info passed by the caller)
- Guards return `true` to allow, `false` or a string (reason) to deny

---

## 2. Instance state machine (refactor)

**File: `packages/core/src/instance-state.ts`** — remove XState, use `createMachine`

```
starting    → { started: active }
active      → { hibernate: hibernated, stop: stopping, destroy: destroying }
hibernated  → { restore: starting, destroy: destroying }
stopping    → { stopped: destroyed }
destroying  → { destroyed: destroyed }
destroyed   → {} (final)
```

Changes from current XState machine:
- **Add** `hibernated → destroying` via `destroy` (real code allows this, XState machine didn't)
- **Remove** `claimed` from events (was listed but had no transition; it's a bus event, not a state event)

Exports preserved: `InstanceStatus`, `InstanceEvent`, `INSTANCE_STATUSES`, `INSTANCE_EVENTS`,
`transition()`, `InvalidTransitionError`. The `instanceMachine` XState export is removed.

---

## 3. Node state machine (extend existing)

**File: `packages/core/src/node.ts`** — add machine alongside existing types

```
online   → { drain: draining }
draining → { shutdown: offline, cancel_drain: online }
offline  → { activate: online }
```

New exports: `NodeEvent`, `NodeEventSchema`, `NODE_EVENTS`, `nodeTransition`, `NODE_TRANSITIONS`

No DB migration needed — `status` column already exists on `nodes`.

---

## 4. Tenant state machine (new)

**New file: `packages/core/src/tenant-state.ts`**

```
idle      → { claim: claiming }
claiming  → { claimed: active, claim_failed: idle }
active    → { release: releasing }
releasing → { hibernated: released, destroyed: idle }
released  → { claim: claiming }
```

**Requires DB migration** — add `status` column to `tenants` table.

---

## 5. Snapshot state machine (new)

**New file: `packages/core/src/snapshot-state.ts`**

```
creating → { created: ready, failed: deleted }
ready    → { expire: expired, delete: deleted }
expired  → { delete: deleted }
deleted  → {} (final)
```

**Requires DB migration** — add `status` column to `snapshots` table.

---

## 6. DB migration

> TODO: Just delete local DB, we dont need migrations.

**New migration: `packages/db/drizzle/XXXX_add_tenant_snapshot_status.sql`**

```sql
ALTER TABLE `tenants` ADD COLUMN `status` text NOT NULL DEFAULT 'idle';
--> statement-breakpoint
UPDATE `tenants` SET `status` = 'active' WHERE `instance_id` IS NOT NULL;
--> statement-breakpoint
UPDATE `tenants` SET `status` = 'released'
  WHERE `instance_id` IS NULL AND `last_snapshot_id` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `snapshots` ADD COLUMN `status` text NOT NULL DEFAULT 'ready';
--> statement-breakpoint
CREATE INDEX `tenants_status_idx` ON `tenants` (`status`);
--> statement-breakpoint
CREATE INDEX `snapshots_status_idx` ON `snapshots` (`status`);
```

**Schema changes in `packages/db/src/schema.ts`:**
- `tenants.status` — `text("status").notNull().default("idle").$type<TenantStatus>()`
- `snapshots.status` — `text("status").notNull().default("ready").$type<SnapshotStatus>()`
- Indexes on both new columns

---

## 7. Wire machines into API layer

### `apps/api/src/instance-manager.ts`

Call `transition()` before every `.set({ status })`:
- `create()`: validates `starting → active` via `"started"`
- `destroy()`: validates `current → destroying` via `"destroy"`, then `destroying → destroyed`
- `stop()`: validates `current → stopping` via `"stop"`, then `stopping → destroyed`
- `hibernate()`: validates `current → hibernated` via `"hibernate"`
- `restoreFromSnapshot()`: validates `starting → active` via `"started"`

### `apps/api/src/tenant-manager.ts`

- `claim()`: transition `"claim"` → do work → `"claimed"` / `"claim_failed"`
- `release()`: transition `"release"` → after hibernate `"hibernated"` / after destroy `"destroyed"`
- `upsertTenant()`: new tenants start as `"claiming"`

### `apps/api/src/snapshot-manager.ts`

- `createGolden()`: insert with `status: "creating"` → on success `"created"` → `"ready"`
- On failure: `"failed"` → `"deleted"` (or hard delete)

### Route error handling

- Catch `InvalidTransitionError` → 409 Conflict in instance/tenant/node routes

### Recovery (`apps/api/src/recovery.ts`)

- **No changes.** Recovery writes status directly to DB, intentionally bypassing the machine.
  Add a comment documenting this is the "force" escape hatch.

---

## 8. Exports update (`packages/core/src/index.ts`)

Add:
- `InvalidTransitionError`, `TransitionMap`, `createMachine` from `./state-machine`
- `NodeEvent`, `NodeEventSchema`, `NODE_EVENTS`, `nodeTransition` from `./node`
- `TenantStatus`, `TenantEvent`, `TenantStatusSchema`, `TenantEventSchema`,
  `TENANT_STATUSES`, `TENANT_EVENTS`, `tenantTransition` from `./tenant-state`
- `SnapshotStatus`, `SnapshotEvent`, `SnapshotStatusSchema`, `SnapshotEventSchema`,
  `SNAPSHOT_STATUSES`, `SNAPSHOT_EVENTS`, `snapshotTransition` from `./snapshot-state`

Remove: `instanceMachine` export, `xstate` from `packages/core/package.json`

---

## Execution order (TDD)

| #  | Task                                               | Files                                           |
| -- | -------------------------------------------------- | ----------------------------------------------- |
| 1  | Create `state-machine.ts` + tests                  | `packages/core/src/state-machine.{ts,test.ts}`  |
| 2  | Refactor instance machine + update tests            | `packages/core/src/instance-state.{ts,test.ts}` |
| 3  | Add node machine to `node.ts` + tests               | `packages/core/src/node.{ts,test.ts}`           |
| 4  | Create tenant machine + tests                       | `packages/core/src/tenant-state.{ts,test.ts}`   |
| 5  | Create snapshot machine + tests                     | `packages/core/src/snapshot-state.{ts,test.ts}` |
| 6  | Update `index.ts` exports, remove xstate dep        | `packages/core/src/index.ts`, `package.json`    |
| 7  | DB migration + schema update                        | `packages/db/drizzle/`, `packages/db/src/schema.ts` |
| 8  | Wire instance machine into `InstanceManager`         | `apps/api/src/instance-manager.ts`              |
| 9  | Wire tenant machine into `TenantManager`             | `apps/api/src/tenant-manager.ts`                |
| 10 | Wire snapshot machine into `SnapshotManager`         | `apps/api/src/snapshot-manager.ts`              |
| 11 | Add 409 error handling in routes                     | `apps/api/src/routes/*.ts`                      |
| 12 | Run full test suite, fix breakage                    | all                                             |

## Verification

1. `bun test packages/core/` — all 4 machine test suites pass
2. `bun test packages/db/` — migration applies, schema matches
3. `bun test apps/api/` — all existing API tests pass + new transition guard tests
4. `bun run lint` — no oxlint errors
5. Verify: calling `stop()` on a hibernated instance returns 409 (not silent success)
6. Verify: recovery still force-sets status without going through machines
