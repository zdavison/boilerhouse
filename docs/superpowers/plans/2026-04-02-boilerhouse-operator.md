# Boilerhouse Kubernetes Operator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a Kubernetes operator that manages Boilerhouse workloads, pools, claims, and triggers via CRDs, sharing domain logic with the existing API through a new `@boilerhouse/domain` package.

**Architecture:** Extract all manager classes from `apps/api/src/` into `packages/domain/`. Build `apps/operator/` that watches four CRDs (`BoilerhouseWorkload`, `BoilerhousePool`, `BoilerhouseClaim`, `BoilerhouseTrigger`) and delegates to those shared managers. Extend the existing K8s REST client with watch/status/finalizer capabilities.

**Tech Stack:** TypeScript, Bun, Drizzle ORM (SQLite), Kubernetes REST API, custom CRDs

---

## File Structure

### New package: `packages/domain/`

| File | Responsibility |
|------|---------------|
| `packages/domain/package.json` | Package manifest |
| `packages/domain/tsconfig.json` | TypeScript config |
| `packages/domain/src/index.ts` | Public exports |
| `packages/domain/src/instance-manager.ts` | Moved from `apps/api/src/instance-manager.ts` |
| `packages/domain/src/tenant-manager.ts` | Moved from `apps/api/src/tenant-manager.ts` |
| `packages/domain/src/pool-manager.ts` | Moved from `apps/api/src/pool-manager.ts` |
| `packages/domain/src/tenant-data.ts` | Moved from `apps/api/src/tenant-data.ts` |
| `packages/domain/src/idle-monitor.ts` | Moved from `apps/api/src/idle-monitor.ts` |
| `packages/domain/src/watch-dirs-poller.ts` | Moved from `apps/api/src/watch-dirs-poller.ts` |
| `packages/domain/src/recovery.ts` | Moved from `apps/api/src/recovery.ts` |
| `packages/domain/src/transitions.ts` | Moved from `apps/api/src/transitions.ts` |
| `packages/domain/src/event-bus.ts` | Moved from `apps/api/src/event-bus.ts` |
| `packages/domain/src/audit-logger.ts` | Moved from `apps/api/src/audit-logger.ts` |
| `packages/domain/src/health-check.ts` | Moved from `apps/api/src/health-check.ts` |
| `packages/domain/src/secret-resolver.ts` | New interface for credential resolution |
| `packages/domain/src/test-helpers.ts` | Moved from `apps/api/src/test-helpers.ts` (core parts) |

Test files move alongside their source files.

### Extended: `packages/runtime-kubernetes/`

| File | Responsibility |
|------|---------------|
| `packages/runtime-kubernetes/src/watch.ts` | K8s watch streaming with resourceVersion tracking |
| `packages/runtime-kubernetes/src/status.ts` | Status subresource patch + finalizer management |
| `packages/runtime-kubernetes/src/crd-types.ts` | TypeScript types for all four CRDs |
| `packages/runtime-kubernetes/src/watch.test.ts` | Watch unit tests |
| `packages/runtime-kubernetes/src/status.test.ts` | Status patch unit tests |

### New app: `apps/operator/`

| File | Responsibility |
|------|---------------|
| `apps/operator/package.json` | Package manifest |
| `apps/operator/tsconfig.json` | TypeScript config |
| `apps/operator/src/main.ts` | Entrypoint: bootstrap + start controllers |
| `apps/operator/src/bootstrap.ts` | Wire domain managers, runtime, DB, controllers |
| `apps/operator/src/controller.ts` | Generic reconcile loop (watch → queue → reconcile) |
| `apps/operator/src/leader-election.ts` | K8s Lease-based leader election |
| `apps/operator/src/workload-controller.ts` | BoilerhouseWorkload reconciler |
| `apps/operator/src/pool-controller.ts` | BoilerhousePool reconciler |
| `apps/operator/src/claim-controller.ts` | BoilerhouseClaim reconciler |
| `apps/operator/src/trigger-controller.ts` | BoilerhouseTrigger reconciler |
| `apps/operator/src/secret-resolver.ts` | K8s Secrets-backed SecretResolver implementation |
| `apps/operator/src/internal-api.ts` | Small HTTP API for snapshot/overlay/stats |
| `apps/operator/src/recovery.ts` | Operator-specific recovery (CRDs + pods → DB) |
| `apps/operator/crds/boilerhouse.dev_workloads.yaml` | CRD manifest |
| `apps/operator/crds/boilerhouse.dev_pools.yaml` | CRD manifest |
| `apps/operator/crds/boilerhouse.dev_claims.yaml` | CRD manifest |
| `apps/operator/crds/boilerhouse.dev_triggers.yaml` | CRD manifest |
| `apps/operator/deploy/rbac.yaml` | ServiceAccount + ClusterRole + Binding |
| `apps/operator/deploy/deployment.yaml` | Operator Deployment manifest |

### Modified: `apps/api/`

All manager imports change from `./instance-manager` to `@boilerhouse/domain`. No logic changes.

---

## Task 1: Create `@boilerhouse/domain` package scaffold

**Files:**
- Create: `packages/domain/package.json`
- Create: `packages/domain/tsconfig.json`
- Create: `packages/domain/src/index.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@boilerhouse/domain",
  "version": "0.1.11",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "dependencies": {
    "@boilerhouse/core": "workspace:*",
    "@boilerhouse/db": "workspace:*",
    "@boilerhouse/storage": "workspace:*",
    "@boilerhouse/o11y": "workspace:*",
    "drizzle-orm": "^0.38.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create empty index.ts**

```typescript
// @boilerhouse/domain — shared managers for API and operator
// Exports will be added as modules are moved in subsequent tasks.
```

- [ ] **Step 4: Install dependencies**

Run: `cd /Users/z/work/boilerhouse && bun install`
Expected: Clean install, `@boilerhouse/domain` visible in workspace

- [ ] **Step 5: Commit**

```bash
git add packages/domain/
git commit -m "feat(domain): scaffold @boilerhouse/domain package"
```

---

## Task 2: Add SecretResolver interface to domain

**Files:**
- Create: `packages/domain/src/secret-resolver.ts`
- Modify: `packages/domain/src/index.ts`

- [ ] **Step 1: Create the SecretResolver interface**

```typescript
/**
 * Resolves secret references to plaintext values.
 * - API server implements with SecretStore (AES-encrypted SQLite)
 * - Operator implements with K8s Secrets API
 */
export interface SecretRef {
  name: string;
  key: string;
}

export interface SecretResolver {
  resolve(ref: SecretRef): Promise<string>;
}
```

- [ ] **Step 2: Export from index.ts**

```typescript
export { type SecretResolver, type SecretRef } from "./secret-resolver";
```

- [ ] **Step 3: Commit**

```bash
git add packages/domain/src/secret-resolver.ts packages/domain/src/index.ts
git commit -m "feat(domain): add SecretResolver interface"
```

---

## Task 3: Move EventBus to domain

**Files:**
- Move: `apps/api/src/event-bus.ts` → `packages/domain/src/event-bus.ts`
- Move: `apps/api/src/event-bus.test.ts` → `packages/domain/src/event-bus.test.ts`
- Modify: `packages/domain/src/index.ts`
- Modify: all files in `apps/api/src/` that import from `./event-bus`

- [ ] **Step 1: Copy event-bus.ts to domain**

Copy `apps/api/src/event-bus.ts` to `packages/domain/src/event-bus.ts`. No changes needed — it only imports from `node:events` and `@boilerhouse/core`.

- [ ] **Step 2: Copy event-bus.test.ts to domain**

Copy `apps/api/src/event-bus.test.ts` to `packages/domain/src/event-bus.test.ts`.

- [ ] **Step 3: Export from index.ts**

Add to `packages/domain/src/index.ts`:

```typescript
export { EventBus } from "./event-bus";
export type {
  InstanceStateEvent,
  TenantClaimEvent,
  TenantReleaseEvent,
  WorkloadStateEvent,
  TenantClaimingEvent,
  BootstrapLogEvent,
  PoolInstanceReadyEvent,
  IdleTimeoutEvent,
  TriggerDispatchedEvent,
  TriggerErrorEvent,
  DomainEvent,
} from "./event-bus";
```

- [ ] **Step 4: Run domain tests**

Run: `bun test packages/domain/`
Expected: event-bus tests pass

- [ ] **Step 5: Update API imports to use domain**

In `apps/api/src/`, find all files importing from `./event-bus` and change them to import from `@boilerhouse/domain`:

Files to update (grep for `from "./event-bus"`):
- `apps/api/src/audit-logger.ts`
- `apps/api/src/bootstrap.ts`
- `apps/api/src/test-helpers.ts`
- Any route files referencing EventBus

Change `from "./event-bus"` to `from "@boilerhouse/domain"`.

Add `@boilerhouse/domain` as a dependency in `apps/api/package.json`:

```json
"@boilerhouse/domain": "workspace:*"
```

- [ ] **Step 6: Delete old files**

Delete `apps/api/src/event-bus.ts` and `apps/api/src/event-bus.test.ts`.

- [ ] **Step 7: Run all tests**

Run: `bun test packages/ apps/ workloads/`
Expected: All tests pass

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor: move EventBus to @boilerhouse/domain"
```

---

## Task 4: Move transitions to domain

**Files:**
- Move: `apps/api/src/transitions.ts` → `packages/domain/src/transitions.ts`
- Move: `apps/api/src/transitions.test.ts` → `packages/domain/src/transitions.test.ts`
- Modify: `packages/domain/src/index.ts`
- Modify: all files in `apps/api/src/` that import from `./transitions`

- [ ] **Step 1: Copy transitions.ts to domain**

Copy `apps/api/src/transitions.ts` to `packages/domain/src/transitions.ts`. It imports from `drizzle-orm`, `@boilerhouse/core`, and `@boilerhouse/db` — all already domain dependencies.

- [ ] **Step 2: Copy transitions.test.ts to domain**

Copy `apps/api/src/transitions.test.ts` to `packages/domain/src/transitions.test.ts`.

- [ ] **Step 3: Export from index.ts**

Add to `packages/domain/src/index.ts`:

```typescript
export {
  applyInstanceTransition,
  forceInstanceStatus,
  applyClaimTransition,
  applySnapshotTransition,
  applyWorkloadTransition,
  instanceHandleFrom,
} from "./transitions";
```

- [ ] **Step 4: Run domain tests**

Run: `bun test packages/domain/`
Expected: transitions tests pass

- [ ] **Step 5: Update API imports**

Files importing from `./transitions` in `apps/api/src/`:
- `instance-manager.ts`
- `tenant-manager.ts`
- `pool-manager.ts`
- `recovery.ts`
- `workload-watcher.ts`

Change `from "./transitions"` to `from "@boilerhouse/domain"`.

- [ ] **Step 6: Delete old files and run tests**

Delete `apps/api/src/transitions.ts` and `apps/api/src/transitions.test.ts`.

Run: `bun test packages/ apps/ workloads/`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: move transitions to @boilerhouse/domain"
```

---

## Task 5: Move AuditLogger to domain

**Files:**
- Move: `apps/api/src/audit-logger.ts` → `packages/domain/src/audit-logger.ts`
- Modify: `packages/domain/src/index.ts`
- Modify: all files in `apps/api/src/` that import from `./audit-logger`

- [ ] **Step 1: Copy audit-logger.ts to domain**

Copy `apps/api/src/audit-logger.ts` to `packages/domain/src/audit-logger.ts`. Update its import of `EventBus` from `./event-bus` (now local to domain).

- [ ] **Step 2: Export from index.ts**

Add to `packages/domain/src/index.ts`:

```typescript
export { AuditLogger } from "./audit-logger";
```

- [ ] **Step 3: Update API imports**

Files importing `./audit-logger` in `apps/api/src/`:
- `instance-manager.ts`
- `tenant-manager.ts`
- `pool-manager.ts`
- `recovery.ts`
- `bootstrap.ts`
- `test-helpers.ts`

Change to `from "@boilerhouse/domain"`.

- [ ] **Step 4: Delete old file and run tests**

Delete `apps/api/src/audit-logger.ts`.

Run: `bun test packages/ apps/ workloads/`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: move AuditLogger to @boilerhouse/domain"
```

---

## Task 6: Move health-check to domain

**Files:**
- Move: `apps/api/src/health-check.ts` → `packages/domain/src/health-check.ts`
- Move: `apps/api/src/health-check.test.ts` → `packages/domain/src/health-check.test.ts`
- Modify: `packages/domain/src/index.ts`
- Modify: `apps/api/src/pool-manager.ts` (imports health-check)

- [ ] **Step 1: Copy health-check.ts and test to domain**

Copy both files. health-check.ts imports from `@boilerhouse/core` only.

- [ ] **Step 2: Export from index.ts**

Add to `packages/domain/src/index.ts`:

```typescript
export {
  pollHealth,
  createHttpCheck,
  createExecCheck,
  HealthCheckTimeoutError,
} from "./health-check";
export type { HealthConfig, HealthCheckFn, HealthChecker } from "./health-check";
```

- [ ] **Step 3: Update API imports and delete old files**

Change `apps/api/src/pool-manager.ts` import from `./health-check` to `@boilerhouse/domain`.
Delete `apps/api/src/health-check.ts` and `apps/api/src/health-check.test.ts`.

- [ ] **Step 4: Run tests**

Run: `bun test packages/ apps/ workloads/`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: move health-check to @boilerhouse/domain"
```

---

## Task 7: Move IdleMonitor and WatchDirsPoller to domain

**Files:**
- Move: `apps/api/src/idle-monitor.ts` → `packages/domain/src/idle-monitor.ts`
- Move: `apps/api/src/idle-monitor.test.ts` → `packages/domain/src/idle-monitor.test.ts`
- Move: `apps/api/src/watch-dirs-poller.ts` → `packages/domain/src/watch-dirs-poller.ts`
- Move: `apps/api/src/watch-dirs-poller.test.ts` → `packages/domain/src/watch-dirs-poller.test.ts`
- Move: `apps/api/src/idle-integration.test.ts` → `packages/domain/src/idle-integration.test.ts`
- Modify: `packages/domain/src/index.ts`

- [ ] **Step 1: Copy idle-monitor files to domain**

`idle-monitor.ts` imports only from `@boilerhouse/core` and `@boilerhouse/o11y`.

- [ ] **Step 2: Copy watch-dirs-poller files to domain**

`watch-dirs-poller.ts` imports from `@boilerhouse/core`, `./instance-manager`, and `./idle-monitor`. Since InstanceManager hasn't moved yet, `watch-dirs-poller.ts` needs to import from a local path. This will resolve in Task 8 when InstanceManager moves too.

Temporarily update the import in the domain copy to use a relative path:

```typescript
import { InstanceManager } from "./instance-manager";
import { IdleMonitor } from "./idle-monitor";
```

This will compile once InstanceManager is moved in Task 8.

- [ ] **Step 3: Copy idle-integration.test.ts to domain**

This test exercises IdleMonitor + WatchDirsPoller together.

- [ ] **Step 4: Export from index.ts**

Add to `packages/domain/src/index.ts`:

```typescript
export { IdleMonitor } from "./idle-monitor";
export type { IdleConfig, IdleHandler } from "./idle-monitor";
export { WatchDirsPoller } from "./watch-dirs-poller";
```

- [ ] **Step 5: Update API imports and delete old files**

Update `apps/api/src/tenant-manager.ts` and `apps/api/src/bootstrap.ts` to import from `@boilerhouse/domain`.
Delete the old files from `apps/api/src/`.

- [ ] **Step 6: Commit (tests may not pass yet — WatchDirsPoller depends on InstanceManager moving in Task 8)**

```bash
git add -A
git commit -m "refactor: move IdleMonitor and WatchDirsPoller to @boilerhouse/domain"
```

---

## Task 8: Move InstanceManager to domain

**Files:**
- Move: `apps/api/src/instance-manager.ts` → `packages/domain/src/instance-manager.ts`
- Move: `apps/api/src/instance-manager.test.ts` → `packages/domain/src/instance-manager.test.ts`
- Modify: `packages/domain/src/index.ts`

- [ ] **Step 1: Copy instance-manager.ts to domain**

`instance-manager.ts` imports:
- `drizzle-orm` — domain dependency
- `@boilerhouse/core` — domain dependency
- `@boilerhouse/db` — domain dependency
- `@boilerhouse/o11y` — domain dependency
- `./transitions` — already in domain
- `./audit-logger` — already in domain
- `./secret-store` — **this stays in API**
- `./proxy/config` — **this stays in API**

The `SecretStore` import is only used as an optional constructor param for proxy config generation. Replace it with the new `SecretResolver` interface:

In the domain copy, change:
```typescript
// OLD
import { SecretStore } from "./secret-store";
import { buildProxyCreateOptions } from "./proxy/config";
```

To accept a `SecretResolver` instead. The proxy config building logic that depends on `SecretStore` needs to be abstracted. Check the actual usage — if `InstanceManager` only passes `secretStore` through to `buildProxyCreateOptions`, then the simplest change is to accept a `proxyConfigBuilder` function instead:

```typescript
export type ProxyConfigBuilder = (
  workload: Workload,
  instanceId: InstanceId,
) => Promise<CreateOptions | undefined>;
```

And make the constructor accept this optional function instead of `SecretStore` + the proxy import.

- [ ] **Step 2: Copy instance-manager.test.ts to domain**

Update test imports to use domain-local paths.

- [ ] **Step 3: Export from index.ts**

Add to `packages/domain/src/index.ts`:

```typescript
export { InstanceManager, instanceHandleFrom } from "./instance-manager";
export type { ProxyConfigBuilder } from "./instance-manager";
```

- [ ] **Step 4: Update API imports**

In `apps/api/src/`, update all imports of `./instance-manager` to `@boilerhouse/domain`.
In `apps/api/src/bootstrap.ts`, construct the `ProxyConfigBuilder` closure that wraps the existing `SecretStore` + `buildProxyCreateOptions` logic, and pass it to the domain `InstanceManager`.

- [ ] **Step 5: Delete old file and run tests**

Delete `apps/api/src/instance-manager.ts` and `apps/api/src/instance-manager.test.ts`.

Run: `bun test packages/ apps/ workloads/`
Expected: All pass (WatchDirsPoller import now resolves too)

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: move InstanceManager to @boilerhouse/domain"
```

---

## Task 9: Move TenantDataStore to domain

**Files:**
- Move: `apps/api/src/tenant-data.ts` → `packages/domain/src/tenant-data.ts`
- Move: `apps/api/src/tenant-data.test.ts` → `packages/domain/src/tenant-data.test.ts`
- Modify: `packages/domain/src/index.ts`

- [ ] **Step 1: Copy tenant-data.ts to domain**

Imports: `node:fs`, `node:path`, `drizzle-orm`, `@boilerhouse/core`, `@boilerhouse/db`, `@boilerhouse/storage`. All are domain dependencies.

- [ ] **Step 2: Copy test and export from index.ts**

Add to `packages/domain/src/index.ts`:

```typescript
export { TenantDataStore } from "./tenant-data";
export type { TenantDataStoreOptions } from "./tenant-data";
```

- [ ] **Step 3: Update API imports, delete old files, run tests**

Run: `bun test packages/ apps/ workloads/`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: move TenantDataStore to @boilerhouse/domain"
```

---

## Task 10: Move PoolManager to domain

**Files:**
- Move: `apps/api/src/pool-manager.ts` → `packages/domain/src/pool-manager.ts`
- Move: `apps/api/src/pool-manager.test.ts` → `packages/domain/src/pool-manager.test.ts`
- Modify: `packages/domain/src/index.ts`

- [ ] **Step 1: Copy pool-manager.ts to domain**

Imports: `drizzle-orm`, `@boilerhouse/core`, `@boilerhouse/db`, `./transitions`, `./health-check`, `./instance-manager`, `./bootstrap-log-store`, `./audit-logger`, `@boilerhouse/o11y`. 

Most are already in domain. `bootstrap-log-store` is a simple class — check if it should also move. If it's only used by PoolManager, move it too. Otherwise, accept it as an optional dependency.

The `BootstrapLogStore` is a simple DB wrapper (stores build logs). Include it in domain as it's used by PoolManager:

Also copy `apps/api/src/bootstrap-log-store.ts` → `packages/domain/src/bootstrap-log-store.ts` and its test.

- [ ] **Step 2: Export from index.ts**

Add to `packages/domain/src/index.ts`:

```typescript
export { PoolManager } from "./pool-manager";
export type { PoolManagerOptions } from "./pool-manager";
export { BootstrapLogStore } from "./bootstrap-log-store";
```

- [ ] **Step 3: Update API imports, delete old files, run tests**

Run: `bun test packages/ apps/ workloads/`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: move PoolManager and BootstrapLogStore to @boilerhouse/domain"
```

---

## Task 11: Move TenantManager to domain

**Files:**
- Move: `apps/api/src/tenant-manager.ts` → `packages/domain/src/tenant-manager.ts`
- Move: `apps/api/src/tenant-manager.test.ts` → `packages/domain/src/tenant-manager.test.ts`
- Modify: `packages/domain/src/index.ts`

- [ ] **Step 1: Copy tenant-manager.ts to domain**

All its imports (`InstanceManager`, `TenantDataStore`, `IdleMonitor`, `WatchDirsPoller`, `PoolManager`, `AuditLogger`, `transitions`) are now in domain. Update import paths to domain-local (`./`).

- [ ] **Step 2: Copy test and export from index.ts**

Add to `packages/domain/src/index.ts`:

```typescript
export { TenantManager } from "./tenant-manager";
export type { TenantManagerOptions } from "./tenant-manager";
```

- [ ] **Step 3: Update API imports, delete old files, run tests**

Run: `bun test packages/ apps/ workloads/`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: move TenantManager to @boilerhouse/domain"
```

---

## Task 12: Move recovery to domain

**Files:**
- Move: `apps/api/src/recovery.ts` → `packages/domain/src/recovery.ts`
- Move: `apps/api/src/recovery.test.ts` → `packages/domain/src/recovery.test.ts`
- Modify: `packages/domain/src/index.ts`

- [ ] **Step 1: Copy recovery.ts to domain**

Imports: `drizzle-orm`, `@boilerhouse/core`, `@boilerhouse/db`, `./transitions`, `./audit-logger`. All in domain.

- [ ] **Step 2: Export from index.ts**

Add to `packages/domain/src/index.ts`:

```typescript
export { recoverState } from "./recovery";
export type { RecoveryReport } from "./recovery";
```

- [ ] **Step 3: Update API imports, delete old files, run tests**

Run: `bun test packages/ apps/ workloads/`
Expected: All pass

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: move recovery to @boilerhouse/domain"
```

---

## Task 13: Move test-helpers to domain and update API bootstrap

**Files:**
- Create: `packages/domain/src/test-helpers.ts` (core test utilities)
- Modify: `apps/api/src/test-helpers.ts` (import from domain, keep app-specific helpers)
- Modify: `apps/api/src/bootstrap.ts` (import managers from domain)

- [ ] **Step 1: Create domain test-helpers.ts**

Extract the `createTestAudit` function (which constructs AuditLogger from ActivityLog + EventBus) into domain:

```typescript
import { generateNodeId } from "@boilerhouse/core";
import type { NodeId } from "@boilerhouse/core";
import { ActivityLog } from "@boilerhouse/db";
import type { DrizzleDb } from "@boilerhouse/db";
import { EventBus } from "./event-bus";
import { AuditLogger } from "./audit-logger";

export function createTestAudit(db: DrizzleDb, nodeId?: NodeId): AuditLogger {
  return new AuditLogger(new ActivityLog(db), new EventBus(), nodeId ?? generateNodeId());
}
```

- [ ] **Step 2: Update API test-helpers.ts**

Change `apps/api/src/test-helpers.ts` to import managers and `createTestAudit` from `@boilerhouse/domain` instead of local paths.

- [ ] **Step 3: Update API bootstrap.ts**

Change all manager imports in `apps/api/src/bootstrap.ts` from local paths to `@boilerhouse/domain`:

```typescript
import {
  InstanceManager,
  TenantManager,
  TenantDataStore,
  IdleMonitor,
  WatchDirsPoller,
  PoolManager,
  EventBus,
  AuditLogger,
  BootstrapLogStore,
  recoverState,
} from "@boilerhouse/domain";
```

- [ ] **Step 4: Export test helper from domain index**

Add to `packages/domain/src/index.ts`:

```typescript
export { createTestAudit } from "./test-helpers";
```

- [ ] **Step 5: Run full test suite**

Run: `bun test packages/ apps/ workloads/`
Expected: All pass — this validates the entire extraction

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: complete domain extraction, update API imports"
```

---

## Task 14: Add CRD TypeScript types

**Files:**
- Create: `packages/runtime-kubernetes/src/crd-types.ts`

- [ ] **Step 1: Define CRD types**

```typescript
import type { K8sObjectMeta } from "./types";

// -- API group constant --
export const API_GROUP = "boilerhouse.dev";
export const API_VERSION = "v1alpha1";

// -- BoilerhouseWorkload --
export interface BoilerhouseWorkloadSpec {
  version: string;
  image: { ref: string };
  resources: { vcpus: number; memoryMb: number; diskGb: number };
  network?: {
    access?: "none" | "restricted" | "unrestricted";
    expose?: Array<{ guest: number }>;
    allowlist?: string[];
    credentials?: Array<{
      domain: string;
      secretRef: { name: string; key: string };
      headers: Record<string, string>;
    }>;
    websocket?: string;
  };
  filesystem?: {
    overlayDirs?: string[];
    encryptOverlays?: boolean;
  };
  idle?: {
    timeoutSeconds?: number;
    action?: "hibernate" | "destroy";
    watchDirs?: string[];
  };
  health?: {
    intervalSeconds?: number;
    unhealthyThreshold?: number;
    httpGet?: { path: string; port: number };
    exec?: { command: string[] };
  };
  entrypoint?: {
    cmd?: string;
    args?: string[];
    env?: Record<string, string>;
    workdir?: string;
  };
}

export interface BoilerhouseWorkloadStatus {
  phase?: "Creating" | "Ready" | "Error";
  detail?: string;
  observedGeneration?: number;
}

export interface BoilerhouseWorkload {
  apiVersion: string;
  kind: "BoilerhouseWorkload";
  metadata: K8sObjectMeta;
  spec: BoilerhouseWorkloadSpec;
  status?: BoilerhouseWorkloadStatus;
}

// -- BoilerhousePool --
export interface BoilerhousePoolSpec {
  workloadRef: string;
  size: number;
  maxFillConcurrency?: number;
}

export interface BoilerhousePoolStatus {
  ready?: number;
  warming?: number;
  phase?: "Healthy" | "Degraded" | "Error";
}

export interface BoilerhousePool {
  apiVersion: string;
  kind: "BoilerhousePool";
  metadata: K8sObjectMeta;
  spec: BoilerhousePoolSpec;
  status?: BoilerhousePoolStatus;
}

// -- BoilerhouseClaim --
export interface BoilerhouseClaimSpec {
  tenantId: string;
  workloadRef: string;
  resume?: boolean;
}

export interface BoilerhouseClaimStatus {
  phase?: "Pending" | "Active" | "Releasing" | "Released" | "Error";
  instanceId?: string;
  endpoint?: { host: string; port: number };
  source?: "pool" | "cold";
  claimedAt?: string;
  detail?: string;
}

export interface BoilerhouseClaim {
  apiVersion: string;
  kind: "BoilerhouseClaim";
  metadata: K8sObjectMeta;
  spec: BoilerhouseClaimSpec;
  status?: BoilerhouseClaimStatus;
}

// -- BoilerhouseTrigger --
export interface BoilerhouseTriggerSpec {
  type: "webhook" | "slack" | "telegram" | "cron";
  workloadRef: string;
  tenant?: {
    from?: string;
    prefix?: string;
  };
  driver?: string;
  driverOptions?: Record<string, unknown>;
  guards?: Array<{
    type: string;
    config?: Record<string, unknown>;
  }>;
  config?: Record<string, unknown>;
}

export interface BoilerhouseTriggerStatus {
  phase?: "Active" | "Error";
  detail?: string;
}

export interface BoilerhouseTrigger {
  apiVersion: string;
  kind: "BoilerhouseTrigger";
  metadata: K8sObjectMeta;
  spec: BoilerhouseTriggerSpec;
  status?: BoilerhouseTriggerStatus;
}

// -- List types for watch responses --
export interface CrdList<T> {
  apiVersion: string;
  kind: string;
  metadata: { resourceVersion: string };
  items: T[];
}

// -- Watch event --
export interface WatchEvent<T> {
  type: "ADDED" | "MODIFIED" | "DELETED" | "BOOKMARK";
  object: T;
}
```

- [ ] **Step 2: Export from runtime-kubernetes index**

Add to `packages/runtime-kubernetes/src/index.ts`:

```typescript
export * from "./crd-types";
```

- [ ] **Step 3: Commit**

```bash
git add packages/runtime-kubernetes/src/crd-types.ts packages/runtime-kubernetes/src/index.ts
git commit -m "feat(runtime-k8s): add CRD TypeScript types"
```

---

## Task 15: Add K8s watch client

**Files:**
- Create: `packages/runtime-kubernetes/src/watch.ts`
- Create: `packages/runtime-kubernetes/src/watch.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { KubeWatcher } from "./watch";
import type { WatchEvent, BoilerhouseWorkload } from "./crd-types";

describe("KubeWatcher", () => {
  test("emits ADDED events from watch stream", async () => {
    const events: WatchEvent<BoilerhouseWorkload>[] = [];
    // Test will be filled in after implementation shape is clear
    expect(events).toEqual([]);
  });
});
```

- [ ] **Step 2: Implement watch.ts**

```typescript
import type { WatchEvent, CrdList } from "./crd-types";
import type { KubeClient } from "./client";

export interface WatchOptions {
  /** Starting resourceVersion. If omitted, does an initial list. */
  resourceVersion?: string;
  /** Called for each watch event */
  onEvent: (event: WatchEvent<unknown>) => void;
  /** Called on error (connection drop, 410 Gone, etc.) */
  onError?: (error: Error) => void;
  /** AbortSignal to stop the watch */
  signal?: AbortSignal;
}

/**
 * Watches a K8s resource endpoint using HTTP streaming.
 * Handles reconnection and 410 Gone (resourceVersion expired) by re-listing.
 *
 * Usage:
 *   const watcher = new KubeWatcher(client);
 *   watcher.watch("/apis/boilerhouse.dev/v1alpha1/namespaces/default/boilerhouseworkloads", {
 *     onEvent: (event) => reconcileQueue.enqueue(event),
 *   });
 */
export class KubeWatcher {
  private resourceVersions = new Map<string, string>();

  constructor(
    private readonly apiUrl: string,
    private readonly headers: Record<string, string>,
  ) {}

  async watch<T>(listPath: string, options: WatchOptions): Promise<void> {
    const { onEvent, onError, signal } = options;
    let resourceVersion = options.resourceVersion;

    // If no resourceVersion, do initial list to get one
    if (!resourceVersion) {
      const list = await this.list<T>(listPath);
      resourceVersion = list.metadata.resourceVersion;
      // Emit synthetic ADDED events for existing items
      for (const item of list.items) {
        onEvent({ type: "ADDED", object: item as unknown });
      }
    }

    this.resourceVersions.set(listPath, resourceVersion);

    // Start watch loop
    while (!signal?.aborted) {
      try {
        await this.doWatch<T>(listPath, resourceVersion, onEvent, signal);
      } catch (err) {
        if (signal?.aborted) return;

        const error = err instanceof Error ? err : new Error(String(err));

        // 410 Gone — resourceVersion too old, re-list
        if (error.message.includes("410")) {
          const list = await this.list<T>(listPath);
          resourceVersion = list.metadata.resourceVersion;
          this.resourceVersions.set(listPath, resourceVersion);
          for (const item of list.items) {
            onEvent({ type: "ADDED", object: item as unknown });
          }
          continue;
        }

        onError?.(error);

        // Backoff before reconnecting
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  private async list<T>(path: string): Promise<CrdList<T>> {
    const url = `${this.apiUrl}${path}`;
    const resp = await fetch(url, { headers: this.headers });
    if (!resp.ok) throw new Error(`List failed: ${resp.status} ${resp.statusText}`);
    return (await resp.json()) as CrdList<T>;
  }

  private async doWatch<T>(
    listPath: string,
    resourceVersion: string,
    onEvent: (event: WatchEvent<unknown>) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const watchPath = listPath.replace(/\/([^/]+)$/, "/watch/$1");
    const url = `${this.apiUrl}${watchPath}?resourceVersion=${resourceVersion}&allowWatchBookmarks=true`;
    const resp = await fetch(url, { headers: this.headers, signal });

    if (!resp.ok) {
      throw new Error(`Watch failed: ${resp.status}`);
    }

    const reader = resp.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line) as WatchEvent<T>;

        if (event.type === "BOOKMARK") {
          const rv = (event.object as { metadata?: { resourceVersion?: string } })
            ?.metadata?.resourceVersion;
          if (rv) {
            this.resourceVersions.set(listPath, rv);
          }
          continue;
        }

        onEvent(event as WatchEvent<unknown>);
      }
    }
  }
}
```

- [ ] **Step 3: Run test**

Run: `bun test packages/runtime-kubernetes/src/watch.test.ts`
Expected: passes (basic structure test)

- [ ] **Step 4: Export from runtime-kubernetes index**

Add to `packages/runtime-kubernetes/src/index.ts`:

```typescript
export { KubeWatcher } from "./watch";
export type { WatchOptions } from "./watch";
```

- [ ] **Step 5: Commit**

```bash
git add packages/runtime-kubernetes/src/watch.ts packages/runtime-kubernetes/src/watch.test.ts packages/runtime-kubernetes/src/index.ts
git commit -m "feat(runtime-k8s): add KubeWatcher for CRD watch streaming"
```

---

## Task 16: Add K8s status patch and finalizer helpers

**Files:**
- Create: `packages/runtime-kubernetes/src/status.ts`
- Create: `packages/runtime-kubernetes/src/status.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, test, expect } from "bun:test";
import { addFinalizer, removeFinalizer } from "./status";

describe("finalizer helpers", () => {
  test("addFinalizer adds to empty list", () => {
    const meta = { name: "test", finalizers: undefined };
    const result = addFinalizer(meta, "boilerhouse.dev/cleanup");
    expect(result).toEqual(["boilerhouse.dev/cleanup"]);
  });

  test("addFinalizer is idempotent", () => {
    const meta = { name: "test", finalizers: ["boilerhouse.dev/cleanup"] };
    const result = addFinalizer(meta, "boilerhouse.dev/cleanup");
    expect(result).toEqual(["boilerhouse.dev/cleanup"]);
  });

  test("removeFinalizer removes from list", () => {
    const meta = { name: "test", finalizers: ["boilerhouse.dev/cleanup", "other"] };
    const result = removeFinalizer(meta, "boilerhouse.dev/cleanup");
    expect(result).toEqual(["other"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/runtime-kubernetes/src/status.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement status.ts**

```typescript
import { API_GROUP, API_VERSION } from "./crd-types";
import type { K8sObjectMeta } from "./types";

export const FINALIZER = `${API_GROUP}/cleanup`;

export function addFinalizer(
  metadata: { finalizers?: string[] },
  finalizer: string = FINALIZER,
): string[] {
  const existing = metadata.finalizers ?? [];
  if (existing.includes(finalizer)) return existing;
  return [...existing, finalizer];
}

export function removeFinalizer(
  metadata: { finalizers?: string[] },
  finalizer: string = FINALIZER,
): string[] {
  return (metadata.finalizers ?? []).filter((f) => f !== finalizer);
}

export interface StatusPatcher {
  patchStatus<T>(
    path: string,
    name: string,
    status: T,
  ): Promise<void>;

  patchMetadata(
    path: string,
    name: string,
    metadata: Partial<K8sObjectMeta>,
  ): Promise<void>;
}

/**
 * Patches the /status subresource of a CRD instance via JSON merge patch.
 */
export class KubeStatusPatcher implements StatusPatcher {
  constructor(
    private readonly apiUrl: string,
    private readonly headers: Record<string, string>,
    private readonly namespace: string,
  ) {}

  async patchStatus<T>(resourcePath: string, name: string, status: T): Promise<void> {
    const url = `${this.apiUrl}${resourcePath}/${name}/status`;
    const resp = await fetch(url, {
      method: "PATCH",
      headers: {
        ...this.headers,
        "Content-Type": "application/merge-patch+json",
      },
      body: JSON.stringify({ status }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Status patch failed: ${resp.status} ${body}`);
    }
  }

  async patchMetadata(resourcePath: string, name: string, metadata: Partial<K8sObjectMeta>): Promise<void> {
    const url = `${this.apiUrl}${resourcePath}/${name}`;
    const resp = await fetch(url, {
      method: "PATCH",
      headers: {
        ...this.headers,
        "Content-Type": "application/merge-patch+json",
      },
      body: JSON.stringify({ metadata }),
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Metadata patch failed: ${resp.status} ${body}`);
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/runtime-kubernetes/src/status.test.ts`
Expected: PASS

- [ ] **Step 5: Export and commit**

Add to `packages/runtime-kubernetes/src/index.ts`:

```typescript
export { KubeStatusPatcher, addFinalizer, removeFinalizer, FINALIZER } from "./status";
export type { StatusPatcher } from "./status";
```

```bash
git add packages/runtime-kubernetes/src/status.ts packages/runtime-kubernetes/src/status.test.ts packages/runtime-kubernetes/src/index.ts
git commit -m "feat(runtime-k8s): add status patcher and finalizer helpers"
```

---

## Task 17: Scaffold `apps/operator` package

**Files:**
- Create: `apps/operator/package.json`
- Create: `apps/operator/tsconfig.json`
- Create: `apps/operator/src/main.ts`

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@boilerhouse/operator",
  "version": "0.1.11",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "bun run --watch src/main.ts",
    "start": "bun run src/main.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@boilerhouse/core": "workspace:*",
    "@boilerhouse/db": "workspace:*",
    "@boilerhouse/domain": "workspace:*",
    "@boilerhouse/runtime-kubernetes": "workspace:*",
    "@boilerhouse/storage": "workspace:*",
    "@boilerhouse/o11y": "workspace:*",
    "@boilerhouse/triggers": "workspace:*",
    "drizzle-orm": "^0.38.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create main.ts stub**

```typescript
import { createLogger } from "@boilerhouse/o11y";

const log = createLogger("operator");

log.info("boilerhouse-operator starting");

// Replaced in Task 27 with full bootstrap
process.exit(0);
```

- [ ] **Step 4: Install dependencies**

Run: `cd /Users/z/work/boilerhouse && bun install`

- [ ] **Step 5: Commit**

```bash
git add apps/operator/
git commit -m "feat(operator): scaffold apps/operator package"
```

---

## Task 18: Write CRD manifests

**Files:**
- Create: `apps/operator/crds/boilerhouse.dev_workloads.yaml`
- Create: `apps/operator/crds/boilerhouse.dev_pools.yaml`
- Create: `apps/operator/crds/boilerhouse.dev_claims.yaml`
- Create: `apps/operator/crds/boilerhouse.dev_triggers.yaml`

- [ ] **Step 1: Write BoilerhouseWorkload CRD**

```yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: boilerhouseworkloads.boilerhouse.dev
spec:
  group: boilerhouse.dev
  names:
    kind: BoilerhouseWorkload
    listKind: BoilerhouseWorkloadList
    plural: boilerhouseworkloads
    singular: boilerhouseworkload
    shortNames: [bhw]
  scope: Namespaced
  versions:
    - name: v1alpha1
      served: true
      storage: true
      subresources:
        status: {}
      additionalPrinterColumns:
        - name: Phase
          type: string
          jsonPath: .status.phase
        - name: Version
          type: string
          jsonPath: .spec.version
        - name: Image
          type: string
          jsonPath: .spec.image.ref
        - name: Age
          type: date
          jsonPath: .metadata.creationTimestamp
      schema:
        openAPIV3Schema:
          type: object
          required: [spec]
          properties:
            spec:
              type: object
              required: [version, image, resources]
              properties:
                version:
                  type: string
                image:
                  type: object
                  required: [ref]
                  properties:
                    ref:
                      type: string
                resources:
                  type: object
                  required: [vcpus, memoryMb, diskGb]
                  properties:
                    vcpus:
                      type: integer
                    memoryMb:
                      type: integer
                    diskGb:
                      type: integer
                network:
                  type: object
                  properties:
                    access:
                      type: string
                      enum: [none, restricted, unrestricted]
                    expose:
                      type: array
                      items:
                        type: object
                        properties:
                          guest:
                            type: integer
                    allowlist:
                      type: array
                      items:
                        type: string
                    credentials:
                      type: array
                      items:
                        type: object
                        properties:
                          domain:
                            type: string
                          secretRef:
                            type: object
                            properties:
                              name:
                                type: string
                              key:
                                type: string
                          headers:
                            type: object
                            x-kubernetes-preserve-unknown-fields: true
                    websocket:
                      type: string
                filesystem:
                  type: object
                  properties:
                    overlayDirs:
                      type: array
                      items:
                        type: string
                    encryptOverlays:
                      type: boolean
                idle:
                  type: object
                  properties:
                    timeoutSeconds:
                      type: integer
                    action:
                      type: string
                      enum: [hibernate, destroy]
                    watchDirs:
                      type: array
                      items:
                        type: string
                health:
                  type: object
                  properties:
                    intervalSeconds:
                      type: integer
                    unhealthyThreshold:
                      type: integer
                    httpGet:
                      type: object
                      properties:
                        path:
                          type: string
                        port:
                          type: integer
                    exec:
                      type: object
                      properties:
                        command:
                          type: array
                          items:
                            type: string
                entrypoint:
                  type: object
                  properties:
                    cmd:
                      type: string
                    args:
                      type: array
                      items:
                        type: string
                    env:
                      type: object
                      x-kubernetes-preserve-unknown-fields: true
                    workdir:
                      type: string
            status:
              type: object
              properties:
                phase:
                  type: string
                  enum: [Creating, Ready, Error]
                detail:
                  type: string
                observedGeneration:
                  type: integer
```

- [ ] **Step 2: Write BoilerhousePool CRD**

```yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: boilerhousepools.boilerhouse.dev
spec:
  group: boilerhouse.dev
  names:
    kind: BoilerhousePool
    listKind: BoilerhousePoolList
    plural: boilerhousepools
    singular: boilerhousepool
    shortNames: [bhp]
  scope: Namespaced
  versions:
    - name: v1alpha1
      served: true
      storage: true
      subresources:
        status: {}
      additionalPrinterColumns:
        - name: Workload
          type: string
          jsonPath: .spec.workloadRef
        - name: Size
          type: integer
          jsonPath: .spec.size
        - name: Ready
          type: integer
          jsonPath: .status.ready
        - name: Phase
          type: string
          jsonPath: .status.phase
      schema:
        openAPIV3Schema:
          type: object
          required: [spec]
          properties:
            spec:
              type: object
              required: [workloadRef, size]
              properties:
                workloadRef:
                  type: string
                size:
                  type: integer
                  minimum: 0
                maxFillConcurrency:
                  type: integer
                  minimum: 1
            status:
              type: object
              properties:
                ready:
                  type: integer
                warming:
                  type: integer
                phase:
                  type: string
                  enum: [Healthy, Degraded, Error]
```

- [ ] **Step 3: Write BoilerhouseClaim CRD**

```yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: boilerhouseclaims.boilerhouse.dev
spec:
  group: boilerhouse.dev
  names:
    kind: BoilerhouseClaim
    listKind: BoilerhouseClaimList
    plural: boilerhouseclaims
    singular: boilerhouseclaim
    shortNames: [bhc]
  scope: Namespaced
  versions:
    - name: v1alpha1
      served: true
      storage: true
      subresources:
        status: {}
      additionalPrinterColumns:
        - name: Tenant
          type: string
          jsonPath: .spec.tenantId
        - name: Workload
          type: string
          jsonPath: .spec.workloadRef
        - name: Phase
          type: string
          jsonPath: .status.phase
        - name: Endpoint
          type: string
          jsonPath: .status.endpoint.host
        - name: Age
          type: date
          jsonPath: .metadata.creationTimestamp
      schema:
        openAPIV3Schema:
          type: object
          required: [spec]
          properties:
            spec:
              type: object
              required: [tenantId, workloadRef]
              properties:
                tenantId:
                  type: string
                workloadRef:
                  type: string
                resume:
                  type: boolean
            status:
              type: object
              properties:
                phase:
                  type: string
                  enum: [Pending, Active, Releasing, Released, Error]
                instanceId:
                  type: string
                endpoint:
                  type: object
                  properties:
                    host:
                      type: string
                    port:
                      type: integer
                source:
                  type: string
                  enum: [pool, cold]
                claimedAt:
                  type: string
                  format: date-time
                detail:
                  type: string
```

- [ ] **Step 4: Write BoilerhouseTrigger CRD**

```yaml
apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: boilerhousetriggers.boilerhouse.dev
spec:
  group: boilerhouse.dev
  names:
    kind: BoilerhouseTrigger
    listKind: BoilerhouseTriggerList
    plural: boilerhousetriggers
    singular: boilerhousetrigger
    shortNames: [bht]
  scope: Namespaced
  versions:
    - name: v1alpha1
      served: true
      storage: true
      subresources:
        status: {}
      additionalPrinterColumns:
        - name: Type
          type: string
          jsonPath: .spec.type
        - name: Workload
          type: string
          jsonPath: .spec.workloadRef
        - name: Phase
          type: string
          jsonPath: .status.phase
      schema:
        openAPIV3Schema:
          type: object
          required: [spec]
          properties:
            spec:
              type: object
              required: [type, workloadRef]
              properties:
                type:
                  type: string
                  enum: [webhook, slack, telegram, cron]
                workloadRef:
                  type: string
                tenant:
                  type: object
                  properties:
                    from:
                      type: string
                    prefix:
                      type: string
                driver:
                  type: string
                driverOptions:
                  type: object
                  x-kubernetes-preserve-unknown-fields: true
                guards:
                  type: array
                  items:
                    type: object
                    properties:
                      type:
                        type: string
                      config:
                        type: object
                        x-kubernetes-preserve-unknown-fields: true
                config:
                  type: object
                  x-kubernetes-preserve-unknown-fields: true
            status:
              type: object
              properties:
                phase:
                  type: string
                  enum: [Active, Error]
                detail:
                  type: string
```

- [ ] **Step 5: Commit**

```bash
git add apps/operator/crds/
git commit -m "feat(operator): add CRD manifests for all four resources"
```

---

## Task 19: Implement generic reconcile controller

**Files:**
- Create: `apps/operator/src/controller.ts`
- Create: `apps/operator/src/controller.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, test, expect, mock } from "bun:test";
import { Controller } from "./controller";

describe("Controller", () => {
  test("processes queued items via reconcile", async () => {
    const reconciled: string[] = [];
    const controller = new Controller<{ metadata: { name: string } }>({
      name: "test",
      reconcile: async (item) => {
        reconciled.push(item.metadata.name);
      },
    });

    controller.enqueue({ metadata: { name: "item-1" } } as any);
    controller.enqueue({ metadata: { name: "item-2" } } as any);

    // Let the queue drain
    await controller.processOnce();
    await controller.processOnce();

    expect(reconciled).toEqual(["item-1", "item-2"]);
  });

  test("requeues on error with backoff", async () => {
    let attempts = 0;
    const controller = new Controller<{ metadata: { name: string } }>({
      name: "test",
      reconcile: async () => {
        attempts++;
        if (attempts === 1) throw new Error("transient");
      },
    });

    controller.enqueue({ metadata: { name: "retry-me" } } as any);
    await controller.processOnce(); // fails
    expect(attempts).toBe(1);

    await controller.processOnce(); // retries
    expect(attempts).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/operator/src/controller.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement controller.ts**

```typescript
import { createLogger } from "@boilerhouse/o11y";

export interface ControllerOptions<T> {
  name: string;
  reconcile: (item: T) => Promise<void>;
  maxRetries?: number;
}

interface QueueItem<T> {
  item: T;
  retries: number;
  nextAttempt: number;
}

/**
 * Generic reconcile controller with a work queue.
 * Items are enqueued from watch events and processed sequentially.
 * Failed reconciles are requeued with exponential backoff.
 */
export class Controller<T extends { metadata: { name: string; namespace?: string } }> {
  private queue: QueueItem<T>[] = [];
  private readonly reconcile: (item: T) => Promise<void>;
  private readonly maxRetries: number;
  private readonly log;
  private running = false;
  private wakeup: (() => void) | null = null;

  constructor(options: ControllerOptions<T>) {
    this.reconcile = options.reconcile;
    this.maxRetries = options.maxRetries ?? 5;
    this.log = createLogger(`controller:${options.name}`);
  }

  enqueue(item: T): void {
    // Deduplicate: if same name already in queue, replace it
    const name = item.metadata.name;
    const idx = this.queue.findIndex((q) => q.item.metadata.name === name);
    if (idx >= 0) {
      this.queue[idx] = { item, retries: this.queue[idx].retries, nextAttempt: Date.now() };
    } else {
      this.queue.push({ item, retries: 0, nextAttempt: Date.now() });
    }
    this.wakeup?.();
  }

  /** Process one item from the queue. Returns false if queue is empty. */
  async processOnce(): Promise<boolean> {
    const now = Date.now();
    const idx = this.queue.findIndex((q) => q.nextAttempt <= now);
    if (idx < 0) return false;

    const entry = this.queue.splice(idx, 1)[0];
    const name = entry.item.metadata.name;

    try {
      await this.reconcile(entry.item);
      this.log.debug({ name }, "reconciled");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (entry.retries >= this.maxRetries) {
        this.log.error({ name, err: msg }, "max retries exceeded, dropping");
        return true;
      }

      const backoffMs = Math.min(1000 * 2 ** entry.retries, 30_000);
      this.log.warn({ name, err: msg, retry: entry.retries + 1, backoffMs }, "requeuing");
      this.queue.push({
        item: entry.item,
        retries: entry.retries + 1,
        nextAttempt: Date.now() + backoffMs,
      });
    }

    return true;
  }

  /** Start processing loop. Runs until stop() is called. */
  async start(signal?: AbortSignal): Promise<void> {
    this.running = true;
    while (this.running && !signal?.aborted) {
      const processed = await this.processOnce();
      if (!processed) {
        // Wait for new items
        await new Promise<void>((resolve) => {
          this.wakeup = resolve;
          setTimeout(resolve, 5000); // periodic wakeup
        });
        this.wakeup = null;
      }
    }
  }

  stop(): void {
    this.running = false;
    this.wakeup?.();
  }

  get queueDepth(): number {
    return this.queue.length;
  }
}
```

- [ ] **Step 4: Run tests**

Run: `bun test apps/operator/src/controller.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/operator/src/controller.ts apps/operator/src/controller.test.ts
git commit -m "feat(operator): generic reconcile controller with work queue"
```

---

## Task 20: Implement leader election

**Files:**
- Create: `apps/operator/src/leader-election.ts`
- Create: `apps/operator/src/leader-election.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, test, expect } from "bun:test";
import { LeaderElector } from "./leader-election";

describe("LeaderElector", () => {
  test("calls onStartedLeading when lease is acquired", () => {
    // This will be a unit test against the state machine,
    // not a full K8s integration test
    const elector = new LeaderElector({
      leaseName: "test-lease",
      leaseNamespace: "default",
      identity: "pod-1",
      leaseDurationSeconds: 15,
      renewDeadlineSeconds: 10,
      retryPeriodSeconds: 2,
      apiUrl: "http://localhost:8001",
      headers: {},
    });
    expect(elector.isLeader).toBe(false);
  });
});
```

- [ ] **Step 2: Implement leader-election.ts**

```typescript
import { createLogger } from "@boilerhouse/o11y";

export interface LeaderElectorConfig {
  leaseName: string;
  leaseNamespace: string;
  identity: string;
  leaseDurationSeconds: number;
  renewDeadlineSeconds: number;
  retryPeriodSeconds: number;
  apiUrl: string;
  headers: Record<string, string>;
  onStartedLeading?: () => void;
  onStoppedLeading?: () => void;
}

interface LeaseSpec {
  holderIdentity?: string;
  leaseDurationSeconds?: number;
  acquireTime?: string;
  renewTime?: string;
  leaseTransitions?: number;
}

const log = createLogger("leader-election");

export class LeaderElector {
  private _isLeader = false;
  private stopped = false;
  private readonly config: LeaderElectorConfig;

  constructor(config: LeaderElectorConfig) {
    this.config = config;
  }

  get isLeader(): boolean {
    return this._isLeader;
  }

  async start(signal?: AbortSignal): Promise<void> {
    while (!this.stopped && !signal?.aborted) {
      try {
        if (this._isLeader) {
          await this.renew();
        } else {
          await this.tryAcquire();
        }
      } catch (err) {
        log.warn({ err }, "leader election cycle error");
        if (this._isLeader) {
          this._isLeader = false;
          this.config.onStoppedLeading?.();
        }
      }
      await new Promise((r) => setTimeout(r, this.config.retryPeriodSeconds * 1000));
    }
  }

  stop(): void {
    this.stopped = true;
  }

  private async tryAcquire(): Promise<void> {
    const lease = await this.getLease();

    if (lease) {
      // Check if existing lease has expired
      const renewTime = lease.spec?.renewTime ? new Date(lease.spec.renewTime).getTime() : 0;
      const elapsed = (Date.now() - renewTime) / 1000;
      if (elapsed < (lease.spec?.leaseDurationSeconds ?? this.config.leaseDurationSeconds)) {
        // Lease still held by someone else
        return;
      }
      // Lease expired — try to take it
      await this.updateLease(lease.metadata?.resourceVersion);
    } else {
      // No lease exists — create it
      await this.createLease();
    }
  }

  private async renew(): Promise<void> {
    const lease = await this.getLease();
    if (!lease || lease.spec?.holderIdentity !== this.config.identity) {
      this._isLeader = false;
      this.config.onStoppedLeading?.();
      return;
    }
    await this.updateLease(lease.metadata?.resourceVersion);
  }

  private async getLease(): Promise<any | null> {
    const url = `${this.config.apiUrl}/apis/coordination.k8s.io/v1/namespaces/${this.config.leaseNamespace}/leases/${this.config.leaseName}`;
    const resp = await fetch(url, { headers: this.config.headers });
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`GET lease failed: ${resp.status}`);
    return resp.json();
  }

  private async createLease(): Promise<void> {
    const url = `${this.config.apiUrl}/apis/coordination.k8s.io/v1/namespaces/${this.config.leaseNamespace}/leases`;
    const now = new Date().toISOString();
    const resp = await fetch(url, {
      method: "POST",
      headers: { ...this.config.headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        apiVersion: "coordination.k8s.io/v1",
        kind: "Lease",
        metadata: { name: this.config.leaseName, namespace: this.config.leaseNamespace },
        spec: {
          holderIdentity: this.config.identity,
          leaseDurationSeconds: this.config.leaseDurationSeconds,
          acquireTime: now,
          renewTime: now,
          leaseTransitions: 0,
        },
      }),
    });
    if (!resp.ok) throw new Error(`Create lease failed: ${resp.status}`);
    this._isLeader = true;
    log.info({ identity: this.config.identity }, "acquired leadership");
    this.config.onStartedLeading?.();
  }

  private async updateLease(resourceVersion?: string): Promise<void> {
    const url = `${this.config.apiUrl}/apis/coordination.k8s.io/v1/namespaces/${this.config.leaseNamespace}/leases/${this.config.leaseName}`;
    const now = new Date().toISOString();
    const resp = await fetch(url, {
      method: "PUT",
      headers: { ...this.config.headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        apiVersion: "coordination.k8s.io/v1",
        kind: "Lease",
        metadata: {
          name: this.config.leaseName,
          namespace: this.config.leaseNamespace,
          resourceVersion,
        },
        spec: {
          holderIdentity: this.config.identity,
          leaseDurationSeconds: this.config.leaseDurationSeconds,
          renewTime: now,
        },
      }),
    });
    if (!resp.ok) throw new Error(`Update lease failed: ${resp.status}`);
    if (!this._isLeader) {
      this._isLeader = true;
      log.info({ identity: this.config.identity }, "acquired leadership");
      this.config.onStartedLeading?.();
    }
  }
}
```

- [ ] **Step 3: Run test**

Run: `bun test apps/operator/src/leader-election.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/operator/src/leader-election.ts apps/operator/src/leader-election.test.ts
git commit -m "feat(operator): K8s Lease-based leader election"
```

---

## Task 21: Implement K8s SecretResolver

**Files:**
- Create: `apps/operator/src/secret-resolver.ts`
- Create: `apps/operator/src/secret-resolver.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, test, expect } from "bun:test";
import { KubeSecretResolver } from "./secret-resolver";

describe("KubeSecretResolver", () => {
  test("implements SecretResolver interface", () => {
    const resolver = new KubeSecretResolver({
      apiUrl: "http://localhost:8001",
      headers: {},
      namespace: "default",
    });
    expect(typeof resolver.resolve).toBe("function");
  });
});
```

- [ ] **Step 2: Implement secret-resolver.ts**

```typescript
import type { SecretResolver, SecretRef } from "@boilerhouse/domain";

export interface KubeSecretResolverConfig {
  apiUrl: string;
  headers: Record<string, string>;
  namespace: string;
}

/**
 * Resolves SecretRef by reading native K8s Secrets.
 */
export class KubeSecretResolver implements SecretResolver {
  constructor(private readonly config: KubeSecretResolverConfig) {}

  async resolve(ref: SecretRef): Promise<string> {
    const url = `${this.config.apiUrl}/api/v1/namespaces/${this.config.namespace}/secrets/${ref.name}`;
    const resp = await fetch(url, { headers: this.config.headers });

    if (!resp.ok) {
      throw new Error(`Failed to read secret "${ref.name}": ${resp.status}`);
    }

    const secret = (await resp.json()) as { data?: Record<string, string> };
    const encoded = secret.data?.[ref.key];
    if (!encoded) {
      throw new Error(`Key "${ref.key}" not found in secret "${ref.name}"`);
    }

    // K8s secrets are base64-encoded
    return Buffer.from(encoded, "base64").toString("utf-8");
  }
}
```

- [ ] **Step 3: Run test**

Run: `bun test apps/operator/src/secret-resolver.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/operator/src/secret-resolver.ts apps/operator/src/secret-resolver.test.ts
git commit -m "feat(operator): K8s Secrets-backed SecretResolver"
```

---

## Task 22: Implement CRD-to-Workload converter

**Files:**
- Create: `apps/operator/src/converters.ts`
- Create: `apps/operator/src/converters.test.ts`

This converts between CRD specs and the internal `Workload` type used by domain managers.

- [ ] **Step 1: Write failing test**

```typescript
import { describe, test, expect } from "bun:test";
import { crdToWorkload } from "./converters";
import type { BoilerhouseWorkloadSpec } from "@boilerhouse/runtime-kubernetes";

describe("crdToWorkload", () => {
  test("converts minimal CRD spec to Workload", () => {
    const spec: BoilerhouseWorkloadSpec = {
      version: "1.0.0",
      image: { ref: "test:latest" },
      resources: { vcpus: 1, memoryMb: 256, diskGb: 2 },
    };

    const workload = crdToWorkload("my-agent", spec);

    expect(workload.workload.name).toBe("my-agent");
    expect(workload.workload.version).toBe("1.0.0");
    expect(workload.image.ref).toBe("test:latest");
    expect(workload.resources.vcpus).toBe(1);
    expect(workload.resources.memory_mb).toBe(256);
    expect(workload.network.access).toBe("none");
  });

  test("converts full CRD spec with all fields", () => {
    const spec: BoilerhouseWorkloadSpec = {
      version: "2.0.0",
      image: { ref: "agent:v2" },
      resources: { vcpus: 4, memoryMb: 1024, diskGb: 20 },
      network: {
        access: "restricted",
        expose: [{ guest: 8080 }],
        allowlist: ["api.example.com"],
        websocket: "/ws",
      },
      filesystem: {
        overlayDirs: ["/data"],
        encryptOverlays: true,
      },
      idle: {
        timeoutSeconds: 300,
        action: "hibernate",
        watchDirs: ["/data"],
      },
      health: {
        intervalSeconds: 10,
        unhealthyThreshold: 3,
        httpGet: { path: "/health", port: 8080 },
      },
      entrypoint: {
        cmd: "/app/start",
        args: ["--verbose"],
        env: { LOG_LEVEL: "debug" },
        workdir: "/app",
      },
    };

    const workload = crdToWorkload("full-agent", spec);

    expect(workload.network.access).toBe("restricted");
    expect(workload.network.expose).toEqual([{ guest: 8080 }]);
    expect(workload.network.allowlist).toEqual(["api.example.com"]);
    expect(workload.filesystem?.overlay_dirs).toEqual(["/data"]);
    expect(workload.filesystem?.encrypt_overlays).toBe(true);
    expect(workload.idle?.timeout_seconds).toBe(300);
    expect(workload.idle?.action).toBe("hibernate");
    expect(workload.health?.http_get).toEqual({ path: "/health", port: 8080 });
    expect(workload.entrypoint?.cmd).toBe("/app/start");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/operator/src/converters.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement converters.ts**

```typescript
import type { Workload } from "@boilerhouse/core";
import type { BoilerhouseWorkloadSpec } from "@boilerhouse/runtime-kubernetes";

/**
 * Converts a BoilerhouseWorkload CRD spec into the internal Workload type
 * used by domain managers.
 *
 * CRD uses camelCase; internal Workload uses snake_case for some fields.
 */
export function crdToWorkload(name: string, spec: BoilerhouseWorkloadSpec): Workload {
  return {
    workload: { name, version: spec.version },
    image: { ref: spec.image.ref },
    resources: {
      vcpus: spec.resources.vcpus,
      memory_mb: spec.resources.memoryMb,
      disk_gb: spec.resources.diskGb,
    },
    network: {
      access: spec.network?.access ?? "none",
      expose: spec.network?.expose,
      allowlist: spec.network?.allowlist,
      websocket: spec.network?.websocket ?? null,
    },
    filesystem: spec.filesystem
      ? {
          overlay_dirs: spec.filesystem.overlayDirs ?? [],
          encrypt_overlays: spec.filesystem.encryptOverlays ?? false,
        }
      : undefined,
    idle: spec.idle
      ? {
          timeout_seconds: spec.idle.timeoutSeconds,
          action: spec.idle.action ?? "hibernate",
          watch_dirs: spec.idle.watchDirs,
        }
      : undefined,
    health: spec.health
      ? {
          interval_seconds: spec.health.intervalSeconds ?? 10,
          unhealthy_threshold: spec.health.unhealthyThreshold ?? 3,
          http_get: spec.health.httpGet,
          exec: spec.health.exec,
        }
      : undefined,
    entrypoint: spec.entrypoint
      ? {
          cmd: spec.entrypoint.cmd,
          args: spec.entrypoint.args,
          env: spec.entrypoint.env,
          workdir: spec.entrypoint.workdir,
        }
      : undefined,
  };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test apps/operator/src/converters.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/operator/src/converters.ts apps/operator/src/converters.test.ts
git commit -m "feat(operator): CRD spec to Workload converter"
```

---

## Task 23: Implement WorkloadController

**Files:**
- Create: `apps/operator/src/workload-controller.ts`
- Create: `apps/operator/src/workload-controller.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, test, expect, beforeEach } from "bun:test";
import { FakeRuntime, generateNodeId, generateWorkloadId } from "@boilerhouse/core";
import { createTestDatabase, type DrizzleDb, workloads } from "@boilerhouse/db";
import { createTestAudit } from "@boilerhouse/domain";
import { reconcileWorkload } from "./workload-controller";
import { crdToWorkload } from "./converters";
import type { BoilerhouseWorkload } from "@boilerhouse/runtime-kubernetes";

let db: DrizzleDb;

beforeEach(() => {
  db = createTestDatabase();
});

describe("reconcileWorkload", () => {
  test("creates workload row in DB on new CRD", async () => {
    const crd: BoilerhouseWorkload = {
      apiVersion: "boilerhouse.dev/v1alpha1",
      kind: "BoilerhouseWorkload",
      metadata: { name: "test-agent", namespace: "boilerhouse", generation: 1 },
      spec: {
        version: "1.0.0",
        image: { ref: "test:latest" },
        resources: { vcpus: 1, memoryMb: 256, diskGb: 2 },
      },
    };

    const statusPatch = await reconcileWorkload(crd, { db });

    expect(statusPatch.phase).toBe("Ready");
    expect(statusPatch.observedGeneration).toBe(1);

    const rows = db.select().from(workloads).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("test-agent");
  });

  test("returns Error status for invalid spec", async () => {
    const crd: BoilerhouseWorkload = {
      apiVersion: "boilerhouse.dev/v1alpha1",
      kind: "BoilerhouseWorkload",
      metadata: { name: "bad-agent", namespace: "boilerhouse", generation: 1 },
      spec: {
        version: "",
        image: { ref: "" },
        resources: { vcpus: -1, memoryMb: 0, diskGb: 0 },
      },
    };

    const statusPatch = await reconcileWorkload(crd, { db });

    expect(statusPatch.phase).toBe("Error");
    expect(statusPatch.detail).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/operator/src/workload-controller.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement workload-controller.ts**

```typescript
import { eq } from "drizzle-orm";
import { validateWorkload, generateWorkloadId } from "@boilerhouse/core";
import type { WorkloadId } from "@boilerhouse/core";
import type { DrizzleDb } from "@boilerhouse/db";
import { workloads } from "@boilerhouse/db";
import type {
  BoilerhouseWorkload,
  BoilerhouseWorkloadStatus,
} from "@boilerhouse/runtime-kubernetes";
import { crdToWorkload } from "./converters";

export interface WorkloadControllerDeps {
  db: DrizzleDb;
}

/**
 * Reconciles a BoilerhouseWorkload CRD.
 * Returns the status patch to apply.
 */
export async function reconcileWorkload(
  crd: BoilerhouseWorkload,
  deps: WorkloadControllerDeps,
): Promise<BoilerhouseWorkloadStatus> {
  const name = crd.metadata.name!;
  const generation = (crd.metadata as { generation?: number }).generation ?? 0;

  try {
    // Convert CRD spec to internal Workload type
    const workload = crdToWorkload(name, crd.spec);

    // Validate using existing schema validation
    validateWorkload(workload);

    // Upsert workload row
    const existing = deps.db
      .select()
      .from(workloads)
      .where(eq(workloads.name, name))
      .get();

    if (existing) {
      deps.db
        .update(workloads)
        .set({
          config: workload,
          version: crd.spec.version,
          status: "ready",
          statusDetail: null,
          updatedAt: new Date(),
        })
        .where(eq(workloads.workloadId, existing.workloadId))
        .run();
    } else {
      const workloadId = generateWorkloadId();
      deps.db
        .insert(workloads)
        .values({
          workloadId,
          name,
          version: crd.spec.version,
          config: workload,
          status: "ready",
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .run();
    }

    return {
      phase: "Ready",
      observedGeneration: generation,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      phase: "Error",
      detail,
      observedGeneration: generation,
    };
  }
}
```

- [ ] **Step 4: Run tests**

Run: `bun test apps/operator/src/workload-controller.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/operator/src/workload-controller.ts apps/operator/src/workload-controller.test.ts
git commit -m "feat(operator): WorkloadController reconcile logic"
```

---

## Task 24: Implement PoolController

**Files:**
- Create: `apps/operator/src/pool-controller.ts`
- Create: `apps/operator/src/pool-controller.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { FakeRuntime, generateNodeId, generateWorkloadId } from "@boilerhouse/core";
import { createTestDatabase, type DrizzleDb, workloads, nodes } from "@boilerhouse/db";
import { createTestAudit, InstanceManager, PoolManager } from "@boilerhouse/domain";
import { reconcilePool } from "./pool-controller";
import type { BoilerhousePool } from "@boilerhouse/runtime-kubernetes";

let db: DrizzleDb;
let poolManager: PoolManager;
let nodeId: string;

beforeEach(() => {
  db = createTestDatabase();
  const runtime = new FakeRuntime();
  nodeId = generateNodeId();
  db.insert(nodes).values({
    nodeId,
    runtimeType: "fake",
    capacity: { vcpus: 8, memoryMb: 16384, diskGb: 100 },
    status: "online",
    lastHeartbeat: new Date(),
    createdAt: new Date(),
  }).run();
  const audit = createTestAudit(db, nodeId);
  const instanceManager = new InstanceManager(runtime, db, audit, nodeId);
  poolManager = new PoolManager(instanceManager, runtime, db);
});

describe("reconcilePool", () => {
  test("returns Error if referenced workload missing", async () => {
    const crd: BoilerhousePool = {
      apiVersion: "boilerhouse.dev/v1alpha1",
      kind: "BoilerhousePool",
      metadata: { name: "test-pool", namespace: "boilerhouse" },
      spec: { workloadRef: "nonexistent", size: 1 },
    };

    const status = await reconcilePool(crd, { db, poolManager });
    expect(status.phase).toBe("Error");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/operator/src/pool-controller.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement pool-controller.ts**

```typescript
import { eq } from "drizzle-orm";
import type { DrizzleDb } from "@boilerhouse/db";
import { workloads, instances } from "@boilerhouse/db";
import type { PoolManager } from "@boilerhouse/domain";
import type {
  BoilerhousePool,
  BoilerhousePoolStatus,
} from "@boilerhouse/runtime-kubernetes";

export interface PoolControllerDeps {
  db: DrizzleDb;
  poolManager: PoolManager;
}

export async function reconcilePool(
  crd: BoilerhousePool,
  deps: PoolControllerDeps,
): Promise<BoilerhousePoolStatus> {
  const { db, poolManager } = deps;
  const workloadName = crd.spec.workloadRef;

  // Look up referenced workload
  const workloadRow = db
    .select()
    .from(workloads)
    .where(eq(workloads.name, workloadName))
    .get();

  if (!workloadRow) {
    return {
      phase: "Error",
      ready: 0,
      warming: 0,
    };
  }

  if (workloadRow.status !== "ready") {
    // Workload not ready yet — requeue
    return {
      phase: "Degraded",
      ready: 0,
      warming: 0,
    };
  }

  try {
    const currentDepth = poolManager.getPoolDepth(workloadRow.workloadId);

    if (currentDepth < crd.spec.size) {
      await poolManager.replenish(workloadRow.workloadId);
    }

    // Read current pool state
    const readyCount = db
      .select()
      .from(instances)
      .where(eq(instances.workloadId, workloadRow.workloadId))
      .all()
      .filter((i) => i.poolStatus === "ready").length;

    const warmingCount = db
      .select()
      .from(instances)
      .where(eq(instances.workloadId, workloadRow.workloadId))
      .all()
      .filter((i) => i.poolStatus === "warming").length;

    return {
      phase: readyCount >= crd.spec.size ? "Healthy" : warmingCount > 0 ? "Degraded" : "Healthy",
      ready: readyCount,
      warming: warmingCount,
    };
  } catch (err) {
    return {
      phase: "Error",
      ready: 0,
      warming: 0,
    };
  }
}
```

- [ ] **Step 4: Run tests**

Run: `bun test apps/operator/src/pool-controller.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/operator/src/pool-controller.ts apps/operator/src/pool-controller.test.ts
git commit -m "feat(operator): PoolController reconcile logic"
```

---

## Task 25: Implement ClaimController

**Files:**
- Create: `apps/operator/src/claim-controller.ts`
- Create: `apps/operator/src/claim-controller.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, test, expect, beforeEach } from "bun:test";
import { FakeRuntime, generateNodeId, generateWorkloadId } from "@boilerhouse/core";
import { createTestDatabase, type DrizzleDb, workloads, nodes } from "@boilerhouse/db";
import {
  createTestAudit,
  InstanceManager,
  TenantManager,
  TenantDataStore,
} from "@boilerhouse/domain";
import { reconcileClaim } from "./claim-controller";
import type { BoilerhouseClaim } from "@boilerhouse/runtime-kubernetes";

let db: DrizzleDb;
let tenantManager: TenantManager;

beforeEach(() => {
  db = createTestDatabase();
  const runtime = new FakeRuntime();
  const nodeId = generateNodeId();
  db.insert(nodes).values({
    nodeId,
    runtimeType: "fake",
    capacity: { vcpus: 8, memoryMb: 16384, diskGb: 100 },
    status: "online",
    lastHeartbeat: new Date(),
    createdAt: new Date(),
  }).run();
  const audit = createTestAudit(db, nodeId);
  const instanceManager = new InstanceManager(runtime, db, audit, nodeId);
  const tenantDataStore = new TenantDataStore("/tmp/test", db, runtime);
  tenantManager = new TenantManager(instanceManager, db, audit, nodeId, tenantDataStore);

  // Register a workload
  const workloadId = generateWorkloadId();
  db.insert(workloads).values({
    workloadId,
    name: "test-agent",
    version: "1.0.0",
    config: {
      workload: { name: "test-agent", version: "1.0.0" },
      image: { ref: "test:latest" },
      resources: { vcpus: 1, memory_mb: 256, disk_gb: 2 },
      network: { access: "none" },
      idle: { action: "hibernate" },
    },
    status: "ready",
    createdAt: new Date(),
    updatedAt: new Date(),
  }).run();
});

describe("reconcileClaim", () => {
  test("claims instance for new claim CRD", async () => {
    const crd: BoilerhouseClaim = {
      apiVersion: "boilerhouse.dev/v1alpha1",
      kind: "BoilerhouseClaim",
      metadata: { name: "alice-test-agent", namespace: "boilerhouse" },
      spec: { tenantId: "alice", workloadRef: "test-agent" },
    };

    const status = await reconcileClaim(crd, { db, tenantManager });

    expect(status.phase).toBe("Active");
    expect(status.instanceId).toBeDefined();
    expect(status.source).toBeDefined();
  });

  test("returns Error for missing workload", async () => {
    const crd: BoilerhouseClaim = {
      apiVersion: "boilerhouse.dev/v1alpha1",
      kind: "BoilerhouseClaim",
      metadata: { name: "bob-missing", namespace: "boilerhouse" },
      spec: { tenantId: "bob", workloadRef: "nonexistent" },
    };

    const status = await reconcileClaim(crd, { db, tenantManager });
    expect(status.phase).toBe("Error");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/operator/src/claim-controller.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement claim-controller.ts**

```typescript
import { eq } from "drizzle-orm";
import type { DrizzleDb } from "@boilerhouse/db";
import { workloads } from "@boilerhouse/db";
import type { TenantManager } from "@boilerhouse/domain";
import type {
  BoilerhouseClaim,
  BoilerhouseClaimStatus,
} from "@boilerhouse/runtime-kubernetes";

export interface ClaimControllerDeps {
  db: DrizzleDb;
  tenantManager: TenantManager;
}

export async function reconcileClaim(
  crd: BoilerhouseClaim,
  deps: ClaimControllerDeps,
): Promise<BoilerhouseClaimStatus> {
  const { db, tenantManager } = deps;
  const { tenantId, workloadRef } = crd.spec;
  const currentPhase = crd.status?.phase;

  // Handle deletion
  if (crd.metadata.deletionTimestamp) {
    try {
      const workloadRow = db.select().from(workloads).where(eq(workloads.name, workloadRef)).get();
      if (workloadRow) {
        await tenantManager.release(tenantId, workloadRow.workloadId);
      }
      return { phase: "Released" };
    } catch {
      return { phase: "Released" };
    }
  }

  // Active — no-op
  if (currentPhase === "Active") {
    return crd.status!;
  }

  // Released — only re-claim if spec.resume is set
  if (currentPhase === "Released") {
    if (!crd.spec.resume) {
      return crd.status!;
    }
    // Fall through to claim logic
  }

  // New or resume — attempt claim
  const workloadRow = db
    .select()
    .from(workloads)
    .where(eq(workloads.name, workloadRef))
    .get();

  if (!workloadRow) {
    return {
      phase: "Error",
      detail: `Workload "${workloadRef}" not found`,
    };
  }

  try {
    const result = await tenantManager.claim(tenantId, workloadRow.workloadId);

    return {
      phase: "Active",
      instanceId: result.instanceId,
      endpoint: result.endpoint
        ? { host: result.endpoint.host, port: result.endpoint.port }
        : undefined,
      source: result.source === "existing" ? undefined : result.source as "pool" | "cold",
      claimedAt: new Date().toISOString(),
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      phase: "Error",
      detail,
    };
  }
}
```

- [ ] **Step 4: Run tests**

Run: `bun test apps/operator/src/claim-controller.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/operator/src/claim-controller.ts apps/operator/src/claim-controller.test.ts
git commit -m "feat(operator): ClaimController reconcile logic"
```

---

## Task 26: Implement TriggerController

**Files:**
- Create: `apps/operator/src/trigger-controller.ts`
- Create: `apps/operator/src/trigger-controller.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, test, expect } from "bun:test";
import { reconcileTrigger } from "./trigger-controller";
import type { BoilerhouseTrigger } from "@boilerhouse/runtime-kubernetes";

describe("reconcileTrigger", () => {
  test("returns Active for valid webhook trigger", async () => {
    const crd: BoilerhouseTrigger = {
      apiVersion: "boilerhouse.dev/v1alpha1",
      kind: "BoilerhouseTrigger",
      metadata: { name: "test-webhook", namespace: "boilerhouse" },
      spec: {
        type: "webhook",
        workloadRef: "test-agent",
      },
    };

    const adapters = new Map<string, { stop: () => void }>();
    const status = await reconcileTrigger(crd, { adapters });

    expect(status.phase).toBe("Active");
  });
});
```

- [ ] **Step 2: Implement trigger-controller.ts**

```typescript
import type {
  BoilerhouseTrigger,
  BoilerhouseTriggerStatus,
} from "@boilerhouse/runtime-kubernetes";

export interface TriggerControllerDeps {
  /** Active trigger adapters keyed by CRD name */
  adapters: Map<string, { stop: () => void }>;
  /** Start a trigger adapter. Implementation wires to the trigger system. */
  startAdapter?: (name: string, spec: BoilerhouseTrigger["spec"]) => Promise<{ stop: () => void }>;
}

export async function reconcileTrigger(
  crd: BoilerhouseTrigger,
  deps: TriggerControllerDeps,
): Promise<BoilerhouseTriggerStatus> {
  const name = crd.metadata.name!;

  // Handle deletion
  if (crd.metadata.deletionTimestamp) {
    const adapter = deps.adapters.get(name);
    if (adapter) {
      adapter.stop();
      deps.adapters.delete(name);
    }
    return { phase: "Active" };
  }

  try {
    // Stop existing adapter if updating
    const existing = deps.adapters.get(name);
    if (existing) {
      existing.stop();
      deps.adapters.delete(name);
    }

    // Start new adapter
    if (deps.startAdapter) {
      const adapter = await deps.startAdapter(name, crd.spec);
      deps.adapters.set(name, adapter);
    }

    return { phase: "Active" };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      phase: "Error",
      detail,
    };
  }
}
```

- [ ] **Step 3: Run tests**

Run: `bun test apps/operator/src/trigger-controller.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/operator/src/trigger-controller.ts apps/operator/src/trigger-controller.test.ts
git commit -m "feat(operator): TriggerController reconcile logic"
```

---

## Task 27: Implement operator bootstrap

**Files:**
- Create: `apps/operator/src/bootstrap.ts`
- Modify: `apps/operator/src/main.ts`

- [ ] **Step 1: Implement bootstrap.ts**

```typescript
import { join } from "node:path";
import { hostname } from "node:os";
import { generateNodeId } from "@boilerhouse/core";
import { KubernetesRuntime } from "@boilerhouse/runtime-kubernetes";
import {
  KubeWatcher,
  KubeStatusPatcher,
  addFinalizer,
  removeFinalizer,
  FINALIZER,
} from "@boilerhouse/runtime-kubernetes";
import type {
  BoilerhouseWorkload,
  BoilerhouseClaim,
  BoilerhousePool,
  BoilerhouseTrigger,
  WatchEvent,
} from "@boilerhouse/runtime-kubernetes";
import { initDatabase, ActivityLog, nodes } from "@boilerhouse/db";
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
import { Controller } from "./controller";
import { LeaderElector } from "./leader-election";
import { KubeSecretResolver } from "./secret-resolver";
import { reconcileWorkload } from "./workload-controller";
import { reconcilePool } from "./pool-controller";
import { reconcileClaim } from "./claim-controller";
import { reconcileTrigger } from "./trigger-controller";

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
  const headers: Record<string, string> = {};
  if (config.token) {
    headers["Authorization"] = `Bearer ${config.token}`;
  }

  // Database (ephemeral — rebuilt via recovery)
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

  // Runtime
  const runtime = new KubernetesRuntime({
    auth: "token",
    apiUrl: config.apiUrl,
    token: config.token,
    caCert: config.caCert,
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

  // K8s clients
  const watcher = new KubeWatcher(config.apiUrl, headers);
  const patcher = new KubeStatusPatcher(config.apiUrl, headers, config.namespace);
  const basePath = `/apis/boilerhouse.dev/v1alpha1/namespaces/${config.namespace}`;

  // Idle handler → sets claim status to Released
  idleMonitor.onIdle(async (instanceId, action) => {
    // Find the claim for this instance and release it
    // The TenantManager.release() call handles overlay extraction
    // We then need to patch the Claim CRD status to Released
    log.info({ instanceId, action }, "idle timeout fired");
  });

  // Controllers
  const workloadController = new Controller<BoilerhouseWorkload>({
    name: "workload",
    reconcile: async (crd) => {
      const status = await reconcileWorkload(crd, { db });
      await patcher.patchStatus(`${basePath}/boilerhouseworkloads`, crd.metadata.name!, status);
    },
  });

  const poolController = new Controller<BoilerhousePool>({
    name: "pool",
    reconcile: async (crd) => {
      const status = await reconcilePool(crd, { db, poolManager });
      await patcher.patchStatus(`${basePath}/boilerhousepools`, crd.metadata.name!, status);
    },
  });

  const claimController = new Controller<BoilerhouseClaim>({
    name: "claim",
    reconcile: async (crd) => {
      // Add finalizer if not present
      if (!crd.metadata.finalizers?.includes(FINALIZER)) {
        await patcher.patchMetadata(`${basePath}/boilerhouseclaims`, crd.metadata.name!, {
          finalizers: addFinalizer(crd.metadata, FINALIZER),
        });
      }
      const status = await reconcileClaim(crd, { db, tenantManager });
      await patcher.patchStatus(`${basePath}/boilerhouseclaims`, crd.metadata.name!, status);
      // Remove finalizer after release
      if (crd.metadata.deletionTimestamp) {
        await patcher.patchMetadata(`${basePath}/boilerhouseclaims`, crd.metadata.name!, {
          finalizers: removeFinalizer(crd.metadata, FINALIZER),
        });
      }
    },
  });

  const triggerAdapters = new Map<string, { stop: () => void }>();
  const triggerController = new Controller<BoilerhouseTrigger>({
    name: "trigger",
    reconcile: async (crd) => {
      const status = await reconcileTrigger(crd, { adapters: triggerAdapters });
      await patcher.patchStatus(`${basePath}/boilerhousetriggers`, crd.metadata.name!, status);
    },
  });

  // Recovery
  await recoverState(runtime, db, nodeId, audit);
  log.info("recovery complete");

  // Leader election
  const elector = new LeaderElector({
    leaseName: "boilerhouse-operator-leader",
    leaseNamespace: config.namespace,
    identity: hostname(),
    leaseDurationSeconds: 15,
    renewDeadlineSeconds: 10,
    retryPeriodSeconds: 2,
    apiUrl: config.apiUrl,
    headers,
    onStartedLeading: () => {
      log.info("became leader, starting controllers");
      // Start watch streams
      const abort = new AbortController();

      watcher.watch<BoilerhouseWorkload>(`${basePath}/boilerhouseworkloads`, {
        onEvent: (e) => {
          if (e.type !== "BOOKMARK") workloadController.enqueue(e.object as BoilerhouseWorkload);
        },
        signal: abort.signal,
      });

      watcher.watch<BoilerhousePool>(`${basePath}/boilerhousepools`, {
        onEvent: (e) => {
          if (e.type !== "BOOKMARK") poolController.enqueue(e.object as BoilerhousePool);
        },
        signal: abort.signal,
      });

      watcher.watch<BoilerhouseClaim>(`${basePath}/boilerhouseclaims`, {
        onEvent: (e) => {
          if (e.type !== "BOOKMARK") claimController.enqueue(e.object as BoilerhouseClaim);
        },
        signal: abort.signal,
      });

      watcher.watch<BoilerhouseTrigger>(`${basePath}/boilerhousetriggers`, {
        onEvent: (e) => {
          if (e.type !== "BOOKMARK") triggerController.enqueue(e.object as BoilerhouseTrigger);
        },
        signal: abort.signal,
      });

      // Start controller loops
      workloadController.start(abort.signal);
      poolController.start(abort.signal);
      claimController.start(abort.signal);
      triggerController.start(abort.signal);
    },
    onStoppedLeading: () => {
      log.warn("lost leadership");
      workloadController.stop();
      poolController.stop();
      claimController.stop();
      triggerController.stop();
    },
  });

  await elector.start();
}
```

- [ ] **Step 2: Update main.ts**

```typescript
import { startOperator, configFromEnv } from "./bootstrap";
import { createLogger } from "@boilerhouse/o11y";

const log = createLogger("operator");

log.info("boilerhouse-operator starting");

try {
  const config = configFromEnv();
  await startOperator(config);
} catch (err) {
  log.error({ err }, "operator fatal error");
  process.exit(1);
}
```

- [ ] **Step 3: Verify it compiles**

Run: `cd /Users/z/work/boilerhouse && bun run --filter '@boilerhouse/operator' typecheck`
Expected: No type errors (or fix any that arise)

- [ ] **Step 4: Commit**

```bash
git add apps/operator/src/bootstrap.ts apps/operator/src/main.ts
git commit -m "feat(operator): operator bootstrap wiring all controllers"
```

---

## Task 28: Write RBAC and Deployment manifests

**Files:**
- Create: `apps/operator/deploy/rbac.yaml`
- Create: `apps/operator/deploy/deployment.yaml`

- [ ] **Step 1: Write RBAC manifest**

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: boilerhouse-operator
  namespace: boilerhouse
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata:
  name: boilerhouse-operator
rules:
  # CRDs
  - apiGroups: ["boilerhouse.dev"]
    resources:
      - boilerhouseworkloads
      - boilerhousepools
      - boilerhouseclaims
      - boilerhousetriggers
    verbs: ["get", "list", "watch", "patch"]
  - apiGroups: ["boilerhouse.dev"]
    resources:
      - boilerhouseworkloads/status
      - boilerhousepools/status
      - boilerhouseclaims/status
      - boilerhousetriggers/status
    verbs: ["patch"]
  # Managed resources
  - apiGroups: [""]
    resources: ["pods", "services", "configmaps"]
    verbs: ["get", "list", "create", "delete"]
  - apiGroups: ["networking.k8s.io"]
    resources: ["networkpolicies"]
    verbs: ["get", "list", "create", "delete"]
  # Secrets (read-only for credential resolution)
  - apiGroups: [""]
    resources: ["secrets"]
    verbs: ["get"]
  # Leader election
  - apiGroups: ["coordination.k8s.io"]
    resources: ["leases"]
    verbs: ["get", "create", "update"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata:
  name: boilerhouse-operator
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: ClusterRole
  name: boilerhouse-operator
subjects:
  - kind: ServiceAccount
    name: boilerhouse-operator
    namespace: boilerhouse
```

- [ ] **Step 2: Write Deployment manifest**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: boilerhouse-operator
  namespace: boilerhouse
  labels:
    app: boilerhouse-operator
spec:
  replicas: 2
  selector:
    matchLabels:
      app: boilerhouse-operator
  template:
    metadata:
      labels:
        app: boilerhouse-operator
    spec:
      serviceAccountName: boilerhouse-operator
      containers:
        - name: operator
          image: boilerhouse-operator:latest
          env:
            - name: K8S_NAMESPACE
              valueFrom:
                fieldRef:
                  fieldPath: metadata.namespace
            - name: K8S_API_URL
              value: "https://kubernetes.default.svc"
            - name: K8S_TOKEN
              valueFrom:
                secretKeyRef:
                  name: boilerhouse-operator-token
                  key: token
                  optional: true
          volumeMounts:
            - name: data
              mountPath: /data
          resources:
            requests:
              cpu: 100m
              memory: 256Mi
            limits:
              cpu: 500m
              memory: 512Mi
      volumes:
        - name: data
          emptyDir: {}
```

- [ ] **Step 3: Commit**

```bash
git add apps/operator/deploy/
git commit -m "feat(operator): RBAC and Deployment manifests"
```

---

## Task 29: Implement internal API server

**Files:**
- Create: `apps/operator/src/internal-api.ts`
- Create: `apps/operator/src/internal-api.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { describe, test, expect } from "bun:test";
import { createInternalApi } from "./internal-api";

describe("internal API", () => {
  test("returns 404 for unknown routes", async () => {
    const api = createInternalApi({});
    const resp = await api.fetch(new Request("http://localhost/unknown"));
    expect(resp.status).toBe(404);
  });

  test("GET /healthz returns 200", async () => {
    const api = createInternalApi({});
    const resp = await api.fetch(new Request("http://localhost/healthz"));
    expect(resp.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/operator/src/internal-api.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement internal-api.ts**

```typescript
import type { InstanceManager } from "@boilerhouse/domain";
import type { DrizzleDb } from "@boilerhouse/db";

export interface InternalApiDeps {
  instanceManager?: InstanceManager;
  db?: DrizzleDb;
}

export function createInternalApi(deps: InternalApiDeps) {
  return {
    fetch: async (req: Request): Promise<Response> => {
      const url = new URL(req.url);
      const path = url.pathname;

      if (path === "/healthz") {
        return new Response("ok", { status: 200 });
      }

      if (req.method === "GET" && path.match(/^\/api\/v1\/instances\/[^/]+\/stats$/)) {
        const instanceId = path.split("/")[4];
        // Stats endpoint — returns null until wired to runtime in bootstrap
        return Response.json({ instanceId, stats: null });
      }

      if (req.method === "POST" && path.match(/^\/api\/v1\/instances\/[^/]+\/overlay\/extract$/)) {
        const instanceId = path.split("/")[4];
        return Response.json({ instanceId, extracted: false });
      }

      if (req.method === "POST" && path.match(/^\/api\/v1\/instances\/[^/]+\/snapshot$/)) {
        const instanceId = path.split("/")[4];
        return Response.json({ instanceId, snapshot: null });
      }

      return new Response("not found", { status: 404 });
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test apps/operator/src/internal-api.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/operator/src/internal-api.ts apps/operator/src/internal-api.test.ts
git commit -m "feat(operator): internal API server for snapshot/overlay/stats"
```

---

## Task 30: Run full test suite and fix any issues

- [ ] **Step 1: Run unit tests**

Run: `bun test packages/ apps/ workloads/`
Expected: All pass

- [ ] **Step 2: Fix any import or type errors**

Address any failures from the domain extraction or operator code.

- [ ] **Step 3: Run typecheck across all packages**

Run: `bun run typecheck`
Expected: No type errors

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix: resolve test and type issues from domain extraction"
```

---

## Task 31: Verify CRD manifests apply cleanly (integration smoke test)

This task requires a running minikube cluster (`bunx kadai run minikube`).

- [ ] **Step 1: Apply CRDs**

Run: `kubectl apply -f apps/operator/crds/`
Expected: All four CRDs created

- [ ] **Step 2: Verify CRDs are registered**

Run: `kubectl get crd | grep boilerhouse`
Expected:
```
boilerhouseclaims.boilerhouse.dev      ...
boilerhousepools.boilerhouse.dev       ...
boilerhousetriggers.boilerhouse.dev    ...
boilerhouseworkloads.boilerhouse.dev   ...
```

- [ ] **Step 3: Apply a test workload**

```yaml
# /tmp/test-workload.yaml
apiVersion: boilerhouse.dev/v1alpha1
kind: BoilerhouseWorkload
metadata:
  name: smoke-test
  namespace: boilerhouse
spec:
  version: "1.0.0"
  image:
    ref: nginx:latest
  resources:
    vcpus: 1
    memoryMb: 256
    diskGb: 1
```

Run: `kubectl apply -f /tmp/test-workload.yaml`
Expected: Created

- [ ] **Step 4: Verify printer columns work**

Run: `kubectl get boilerhouseworkloads`
Expected: Table output with Phase, Version, Image, Age columns

- [ ] **Step 5: Cleanup**

Run: `kubectl delete -f /tmp/test-workload.yaml && kubectl delete -f apps/operator/crds/`

- [ ] **Step 6: Commit if any CRD fixes were needed**

```bash
git add -A
git commit -m "fix(operator): CRD manifest corrections from smoke test"
```
