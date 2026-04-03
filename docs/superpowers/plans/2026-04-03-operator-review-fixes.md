# Operator Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all 18 issues identified in the code review of the Boilerhouse Kubernetes operator PR.

**Architecture:** Fixes touch `packages/runtime-kubernetes/src/status.ts`, `apps/operator/src/controller.ts`, `apps/operator/src/leader-election.ts`, `apps/operator/src/secret-resolver.ts`, `apps/operator/src/bootstrap.ts`, `apps/operator/src/workload-controller.ts`, `apps/operator/src/pool-controller.ts`, `apps/operator/deploy/deployment.yaml`, and `apps/operator/deploy/rbac.yaml`. Each task is self-contained and targets one or two related issues.

**Tech Stack:** TypeScript, Bun, Drizzle ORM, Kubernetes REST API, bun:test

---

### Task 1: Fix `patchMetadata` to use merge-patch and handle 404 (issues 3, 12-partial)

**Files:**
- Modify: `packages/runtime-kubernetes/src/status.ts`

`patchMetadata` currently uses `strategic-merge-patch+json` which is unsupported for CRDs (only `merge-patch+json` and `json-patch+json` work). Also, when a DELETED event causes a finalizer-removal patch, the object is gone and the API returns 404; this should be a no-op, not an error.

- [ ] **Step 1: Write the failing test**

In `packages/runtime-kubernetes/src/status.ts` there is no unit test file. But the behaviour is verified by checking `Content-Type` in the patch call. Since `KubeStatusPatcher` wraps `fetch`, we'll verify the fix by reading the code carefully and ensuring the right content type is used. For now, verify via code inspection that `patchMetadata` calls `mergePatch` (not `strategicMergePatch`).

Run the existing tests first to ensure they pass before changes:

```sh
bun test packages/runtime-kubernetes/ --timeout 10000
```

Expected: all pass (or no tests yet — that's fine).

- [ ] **Step 2: Fix `patchMetadata` to use merge-patch and tolerate 404**

In `packages/runtime-kubernetes/src/status.ts`, change `patchMetadata` and `patch`:

```typescript
async patchMetadata(namespace: string, name: string, patch: Partial<TMeta>): Promise<void> {
  const path = `/apis/${this.nsPath(namespace)}/${name}`;
  await this.mergePatch(path, { metadata: patch });
}
```

(Remove `strategicMergePatch` call — already uses `mergePatch` on the same private method.)

Also change the `patch` private method to treat 404 as a no-op (for DELETED events racing with finalizer removal):

```typescript
private async patch(path: string, body: unknown, contentType: string): Promise<void> {
  const url = `${this.apiUrl}${path}`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": contentType,
      Accept: "application/json",
    },
    body: JSON.stringify(body),
    tls: this.tlsOptions,
  } as RequestInit);

  // 404 is a no-op: the object was already deleted (race between DELETED event and finalizer patch)
  if (res.status === 404) {
    await res.body?.cancel();
    return;
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let message = `K8s PATCH ${path}: ${res.status}`;
    try {
      const errBody = JSON.parse(text) as { message?: string };
      if (errBody.message) message = errBody.message;
    } catch {
      if (text) message += ` - ${text.slice(0, 200)}`;
    }
    throw new KubernetesRuntimeError(message, res.status);
  }

  // Consume response body to avoid connection leaks
  await res.body?.cancel();
}
```

- [ ] **Step 3: Verify tests still pass**

```sh
bun test packages/runtime-kubernetes/ --timeout 10000
```

Expected: all pass.

- [ ] **Step 4: Commit**

```sh
git add packages/runtime-kubernetes/src/status.ts
git commit -m "fix(runtime-k8s): use merge-patch for CRD metadata; treat 404 as no-op"
```

---

### Task 2: Fix Controller deduplication to be namespace-aware + fix wakeup race (issues 2, 15)

**Files:**
- Modify: `apps/operator/src/controller.ts`
- Modify: `apps/operator/src/controller.test.ts`

Two bugs: (1) dedup key is name-only — two CRDs with same name in different namespaces collide. (2) Items enqueued while the loop is between `processOnce()→false` and `this.wakeup = resolve` wait up to 5s.

- [ ] **Step 1: Add failing test for namespace-aware deduplication**

Add to `apps/operator/src/controller.test.ts`:

```typescript
test("does not deduplicate items with same name but different namespace", async () => {
  const reconciled: string[] = [];
  const controller = new Controller<{ metadata: { name: string; namespace?: string } }>({
    name: "test",
    reconcile: async (item) => {
      reconciled.push(`${item.metadata.namespace}/${item.metadata.name}`);
    },
  });

  controller.enqueue({ metadata: { name: "item-1", namespace: "ns-a" } } as any);
  controller.enqueue({ metadata: { name: "item-1", namespace: "ns-b" } } as any);

  await controller.processOnce();
  await controller.processOnce();

  expect(reconciled).toContain("ns-a/item-1");
  expect(reconciled).toContain("ns-b/item-1");
  expect(reconciled.length).toBe(2);
});
```

- [ ] **Step 2: Run to confirm failure**

```sh
bun test apps/operator/src/controller.test.ts
```

Expected: new test fails ("does not deduplicate items with same name but different namespace").

- [ ] **Step 3: Fix `enqueue` to use namespace-qualified key, and fix wakeup race**

Replace the `enqueue` method and the sleep block in `start` in `apps/operator/src/controller.ts`:

```typescript
enqueue(item: T): void {
  // Deduplicate: if same namespace+name already in queue, replace it
  const key = `${item.metadata.namespace ?? ""}/${item.metadata.name}`;
  const idx = this.queue.findIndex(
    (q) =>
      `${q.item.metadata.namespace ?? ""}/${q.item.metadata.name}` === key,
  );
  if (idx >= 0) {
    this.queue[idx] = { item, retries: this.queue[idx].retries, nextAttempt: Date.now() };
  } else {
    this.queue.push({ item, retries: 0, nextAttempt: Date.now() });
  }
  this.wakeup?.();
}
```

And replace the sleep block inside `start`:

```typescript
if (!processed) {
  // Wait for new items — set wakeup BEFORE checking queue to avoid race:
  // an enqueue() between processOnce() returning false and wakeup being set
  // would otherwise wait up to 5s.
  await new Promise<void>((resolve) => {
    this.wakeup = resolve;
    // If an item arrived before we set wakeup, wake up immediately
    if (this.queue.length > 0) {
      resolve();
      return;
    }
    setTimeout(resolve, 5000); // periodic wakeup
  });
  this.wakeup = null;
}
```

- [ ] **Step 4: Run tests to confirm all pass**

```sh
bun test apps/operator/src/controller.test.ts
```

Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

```sh
git add apps/operator/src/controller.ts apps/operator/src/controller.test.ts
git commit -m "fix(operator): namespace-aware controller dedup; fix wakeup race window"
```

---

### Task 3: Fix LeaderElector — enforce renewDeadline, increment leaseTransitions, add TLS (issues 4, 5, 9-partial)

**Files:**
- Modify: `apps/operator/src/leader-election.ts`
- Modify: `apps/operator/src/leader-election.test.ts`

Three bugs: (1) `renewDeadlineSeconds` is configured but never enforced — split-brain risk. (2) `leaseTransitions` is never incremented when leadership changes hands. (3) `fetch` calls have no TLS/CA options.

- [ ] **Step 1: Add `caCert` to config interface and add failing test for renewDeadline**

The test needs to verify that if `renew()` cannot succeed within `renewDeadlineSeconds`, `onStoppedLeading` is called. Since we can't easily mock time in this test, we'll verify the internal `lastRenewMs` field is set and the deadline check fires. Add to `apps/operator/src/leader-election.test.ts`:

```typescript
test("steps down if renew deadline exceeded", async () => {
  let stopped = false;
  const elector = new LeaderElector({
    leaseName: "test-lease",
    leaseNamespace: "default",
    identity: "pod-1",
    leaseDurationSeconds: 15,
    renewDeadlineSeconds: 10,
    retryPeriodSeconds: 2,
    apiUrl: "http://localhost:8001",
    headers: {},
    onStoppedLeading: () => { stopped = true; },
  });

  // Force isLeader=true and lastRenewMs to be well past deadline
  (elector as any)._isLeader = true;
  (elector as any).lastRenewMs = Date.now() - 11_000; // 11s ago, deadline is 10s

  elector.checkRenewDeadline();

  expect(stopped).toBe(true);
  expect(elector.isLeader).toBe(false);
});
```

- [ ] **Step 2: Run to confirm failure**

```sh
bun test apps/operator/src/leader-election.test.ts
```

Expected: new test fails ("elector.checkRenewDeadline is not a function").

- [ ] **Step 3: Rewrite `leader-election.ts` with all three fixes**

Replace `apps/operator/src/leader-election.ts` with:

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
  caCert?: string;
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
  private lastRenewMs = 0;
  private readonly config: LeaderElectorConfig;
  private readonly tlsOptions: { rejectUnauthorized: boolean; ca?: string };

  constructor(config: LeaderElectorConfig) {
    this.config = config;
    this.tlsOptions = config.caCert
      ? { rejectUnauthorized: true, ca: config.caCert }
      : { rejectUnauthorized: false };
  }

  get isLeader(): boolean {
    return this._isLeader;
  }

  /** Exposed for testing — checks if renewDeadline has been exceeded. */
  checkRenewDeadline(): void {
    if (
      this._isLeader &&
      this.lastRenewMs > 0 &&
      Date.now() - this.lastRenewMs > this.config.renewDeadlineSeconds * 1000
    ) {
      log.warn({ identity: this.config.identity }, "renew deadline exceeded, stepping down");
      this._isLeader = false;
      this.config.onStoppedLeading?.();
    }
  }

  async start(signal?: AbortSignal): Promise<void> {
    while (!this.stopped && !signal?.aborted) {
      // Enforce renewDeadline before each cycle
      this.checkRenewDeadline();

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
      // Lease expired — try to take it (increment leaseTransitions)
      const prevTransitions = lease.spec?.leaseTransitions ?? 0;
      await this.updateLease(lease.metadata?.resourceVersion, prevTransitions + 1);
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
    await this.updateLease(lease.metadata?.resourceVersion, lease.spec?.leaseTransitions);
    this.lastRenewMs = Date.now();
  }

  private async getLease(): Promise<any | null> {
    const url = `${this.config.apiUrl}/apis/coordination.k8s.io/v1/namespaces/${this.config.leaseNamespace}/leases/${this.config.leaseName}`;
    const resp = await fetch(url, {
      headers: this.config.headers,
      tls: this.tlsOptions,
    } as RequestInit);
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
      tls: this.tlsOptions,
    } as RequestInit);
    if (!resp.ok) throw new Error(`Create lease failed: ${resp.status}`);
    this._isLeader = true;
    this.lastRenewMs = Date.now();
    log.info({ identity: this.config.identity }, "acquired leadership");
    this.config.onStartedLeading?.();
  }

  private async updateLease(resourceVersion?: string, leaseTransitions?: number): Promise<void> {
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
          leaseTransitions: leaseTransitions ?? 0,
        },
      }),
      tls: this.tlsOptions,
    } as RequestInit);
    if (!resp.ok) throw new Error(`Update lease failed: ${resp.status}`);
    if (!this._isLeader) {
      this._isLeader = true;
      this.lastRenewMs = Date.now();
      log.info({ identity: this.config.identity }, "acquired leadership");
      this.config.onStartedLeading?.();
    }
  }
}
```

- [ ] **Step 4: Run tests**

```sh
bun test apps/operator/src/leader-election.test.ts
```

Expected: all 3 tests pass.

- [ ] **Step 5: Commit**

```sh
git add apps/operator/src/leader-election.ts apps/operator/src/leader-election.test.ts
git commit -m "fix(operator): enforce renewDeadline, increment leaseTransitions, add TLS to leader-election"
```

---

### Task 4: Fix KubeSecretResolver — add TLS options (issue 9-partial)

**Files:**
- Modify: `apps/operator/src/secret-resolver.ts`
- Modify: `apps/operator/src/secret-resolver.test.ts`

`KubeSecretResolver.resolve()` uses raw `fetch` without TLS options, unlike `KubeWatcher` and `KubeStatusPatcher` which both pass `tls` options. This breaks in clusters where the CA is not system-trusted.

- [ ] **Step 1: Add `caCert` to `KubeSecretResolverConfig` and use TLS options**

Replace `apps/operator/src/secret-resolver.ts`:

```typescript
import type { SecretResolver, SecretRef } from "@boilerhouse/domain";

export interface KubeSecretResolverConfig {
  apiUrl: string;
  headers: Record<string, string>;
  namespace: string;
  caCert?: string;
}

/**
 * Resolves SecretRef by reading native K8s Secrets.
 */
export class KubeSecretResolver implements SecretResolver {
  private readonly tlsOptions: { rejectUnauthorized: boolean; ca?: string };

  constructor(private readonly config: KubeSecretResolverConfig) {
    this.tlsOptions = config.caCert
      ? { rejectUnauthorized: true, ca: config.caCert }
      : { rejectUnauthorized: false };
  }

  async resolve(ref: SecretRef): Promise<string> {
    const url = `${this.config.apiUrl}/api/v1/namespaces/${this.config.namespace}/secrets/${ref.name}`;
    const resp = await fetch(url, {
      headers: this.config.headers,
      tls: this.tlsOptions,
    } as RequestInit);

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

- [ ] **Step 2: Update bootstrap to pass `caCert` to KubeSecretResolver**

In `apps/operator/src/bootstrap.ts`, update the `KubeSecretResolver` construction (lines 92–96):

```typescript
const secretResolver = new KubeSecretResolver({
  apiUrl: config.apiUrl,
  headers: config.token ? { Authorization: `Bearer ${config.token}` } : {},
  namespace: config.namespace,
  caCert: config.caCert,
});
```

- [ ] **Step 3: Run secret-resolver tests**

```sh
bun test apps/operator/src/secret-resolver.test.ts
```

Expected: all pass.

- [ ] **Step 4: Commit**

```sh
git add apps/operator/src/secret-resolver.ts apps/operator/src/bootstrap.ts
git commit -m "fix(operator): add TLS/caCert support to KubeSecretResolver"
```

---

### Task 5: Fix bootstrap ordering — move `onIdle` after deps, move recovery into `onStartedLeading` (issues 1, 11)

**Files:**
- Modify: `apps/operator/src/bootstrap.ts`

Two ordering bugs: (1) `idleMonitor.onIdle(...)` is registered at line 125, but captures `basePath` (line 184) and `claimPatcher` (line 195) which are declared after it. Works at runtime due to async deferral, but fragile. (2) `recoverState` runs before leader election on every replica — if recovery mutates state, two pods racing can corrupt data. Recovery should only run on the leader.

- [ ] **Step 1: Move `idleMonitor.onIdle(...)` registration to after `claimPatcher` is declared**

In `apps/operator/src/bootstrap.ts`:

1. Delete the entire `idleMonitor.onIdle(async (instanceId, action) => { ... });` block (lines 124–181).
2. Move it to after the `claimPatcher` declaration (after line 198), inserting it at line 199 (before the `// Controllers` comment).

The block to move is exactly:

```typescript
// Idle handler — release the claim and patch the CR status
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
```

Insert it immediately after line 198 (after `const claimPatcher = ...` and `const triggerPatcher = ...`), before the `// Controllers` comment.

- [ ] **Step 2: Move `recoverState` call into `onStartedLeading`**

Remove the following block from its current location at ~line 294:

```typescript
// Recovery
await recoverState(runtime, db, nodeId, audit);
log.info("recovery complete");
```

Add it as the first thing inside `onStartedLeading`, before the `controllerAbort = new AbortController()` line:

```typescript
onStartedLeading: async () => {
  log.info("became leader, starting recovery and controllers");
  await recoverState(runtime, db, nodeId, audit);
  log.info("recovery complete");
  controllerAbort = new AbortController();
  // ... rest of the handler
},
```

Note: `onStartedLeading` must also be typed as `async` (change the arrow function signature). Update the `LeaderElectorConfig` type if needed — confirm `onStartedLeading` accepts `() => void | Promise<void>`.

- [ ] **Step 3: Check `LeaderElectorConfig.onStartedLeading` accepts async**

In `apps/operator/src/leader-election.ts`, verify `onStartedLeading?: () => void;` — update it to `onStartedLeading?: () => void | Promise<void>;` and `onStoppedLeading?: () => void | Promise<void>;` and update the call sites to `await this.config.onStartedLeading?.()` and `await this.config.onStoppedLeading?.()`.

Update `leader-election.ts` callbacks:

```typescript
// In createLease():
this._isLeader = true;
this.lastRenewMs = Date.now();
log.info({ identity: this.config.identity }, "acquired leadership");
await this.config.onStartedLeading?.();

// In updateLease(), when transitioning to leader:
if (!this._isLeader) {
  this._isLeader = true;
  this.lastRenewMs = Date.now();
  log.info({ identity: this.config.identity }, "acquired leadership");
  await this.config.onStartedLeading?.();
}

// In renew(), when losing leadership:
this._isLeader = false;
await this.config.onStoppedLeading?.();

// In start(), on error:
if (this._isLeader) {
  this._isLeader = false;
  await this.config.onStoppedLeading?.();
}

// In checkRenewDeadline():
this._isLeader = false;
await this.config.onStoppedLeading?.();
// Note: checkRenewDeadline must become async too
```

Update `LeaderElectorConfig`:

```typescript
onStartedLeading?: () => void | Promise<void>;
onStoppedLeading?: () => void | Promise<void>;
```

- [ ] **Step 4: Run tests**

```sh
bun test apps/operator/src/leader-election.test.ts
bun test packages/ apps/ --timeout 30000
```

Expected: all pass.

- [ ] **Step 5: Commit**

```sh
git add apps/operator/src/bootstrap.ts apps/operator/src/leader-election.ts
git commit -m "fix(operator): move onIdle after deps; move recovery into onStartedLeading (leader-only)"
```

---

### Task 6: Filter DELETED events from watcher enqueue (issue 12)

**Files:**
- Modify: `apps/operator/src/bootstrap.ts`

When K8s emits a `DELETED` watch event, the object is already gone. Enqueueing it causes `patchMetadata` (finalizer removal) to hit 404. The 404 is now a no-op (Task 1), but the extra reconcile is still wasteful and semantically wrong — a DELETED object should not trigger a new reconcile. Filter these events.

- [ ] **Step 1: Update all four watcher `onEvent` handlers in bootstrap.ts**

Find the four blocks that look like:

```typescript
onEvent: (e) => {
  if (e.type !== "BOOKMARK") workloadController.enqueue(e.object);
},
```

Change each to also exclude `"DELETED"`:

```typescript
onEvent: (e) => {
  if (e.type !== "BOOKMARK" && e.type !== "DELETED") workloadController.enqueue(e.object);
},
```

Do the same for `poolController`, `claimController`, and `triggerController`.

- [ ] **Step 2: Run all operator tests**

```sh
bun test apps/operator/ --timeout 30000
```

Expected: all pass.

- [ ] **Step 3: Commit**

```sh
git add apps/operator/src/bootstrap.ts
git commit -m "fix(operator): exclude DELETED watch events from controller enqueue"
```

---

### Task 7: Fix workload controller deletion path — skip status patch on clean delete (issue 6)

**Files:**
- Modify: `apps/operator/src/bootstrap.ts`
- Modify: `apps/operator/src/workload-controller.ts`

On the deletion path, `reconcileWorkload` returns `phase: "Ready"` after removing the DB row. Bootstrap then patches this onto the CR before removing the finalizer. This is misleading (the object is being deleted) and creates an extra write. Fix: don't patch status on successful deletion — only patch on `Error`.

- [ ] **Step 1: Change the workload reconcile closure in `bootstrap.ts`**

Locate the `workloadController = new Controller<BoilerhouseWorkload>` block. Change the reconcile logic to conditionally skip the status patch on deletion:

```typescript
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
```

- [ ] **Step 2: Run workload controller tests**

```sh
bun test apps/operator/src/workload-controller.test.ts
```

Expected: all pass.

- [ ] **Step 3: Commit**

```sh
git add apps/operator/src/bootstrap.ts
git commit -m "fix(operator): skip status patch on clean workload deletion; only patch on Error"
```

---

### Task 8: Fix pool controller — real warming count + error detail (issues 7, 16)

**Files:**
- Modify: `apps/operator/src/pool-controller.ts`
- Modify: `apps/operator/src/pool-controller.test.ts`

Two bugs: (1) `warming` is always hardcoded to 0. (2) The catch block omits the error `detail` field.

For warming count: `PoolManager.getPoolDepth` counts only `ready` instances. We need warming instances too. Since `pool-controller` already has `db` in its deps, add an inline DB query using `instances` table.

- [ ] **Step 1: Add failing test for warming count**

Add to `apps/operator/src/pool-controller.test.ts` imports:

```typescript
import { instances } from "@boilerhouse/db";
```

Add test:

```typescript
test("error result includes detail message", async () => {
  // No workload inserted — should error with a reason
  const crd = makePoolCrd("no-such-workload", 1);
  const status = await reconcilePool(crd, { db, poolManager });
  expect(status.phase).toBe("Error");
  // detail should be present (non-empty string or undefined — but we want it defined)
  // Currently it's missing entirely — this test verifies the fix
  expect(status).toHaveProperty("detail");
});
```

- [ ] **Step 2: Run to confirm failure**

```sh
bun test apps/operator/src/pool-controller.test.ts
```

Expected: "error result includes detail message" fails (detail is missing).

- [ ] **Step 3: Fix pool-controller.ts**

Replace `apps/operator/src/pool-controller.ts` with:

```typescript
import { eq, and } from "drizzle-orm";
import type { WorkloadId } from "@boilerhouse/core";
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

/**
 * Reconciles a BoilerhousePool CRD.
 * Looks up the referenced workload, compares pool depth to target size,
 * and replenishes if needed.
 */
export async function reconcilePool(
  crd: BoilerhousePool,
  deps: PoolControllerDeps,
): Promise<BoilerhousePoolStatus> {
  const workloadName = crd.spec.workloadRef;
  const targetSize = crd.spec.size;

  try {
    // 0. Deletion: drain the pool and return
    if (crd.metadata.deletionTimestamp) {
      const workloadRow = deps.db
        .select()
        .from(workloads)
        .where(eq(workloads.name, workloadName))
        .get();

      if (workloadRow) {
        await deps.poolManager.drain(workloadRow.workloadId as WorkloadId);
      }

      return {
        phase: "Healthy",
        ready: 0,
        warming: 0,
      };
    }

    // 1. Look up referenced workload by name
    const workloadRow = deps.db
      .select()
      .from(workloads)
      .where(eq(workloads.name, workloadName))
      .get();

    if (!workloadRow) {
      return {
        phase: "Error",
        ready: 0,
        warming: 0,
        detail: `Workload "${workloadName}" not found`,
      };
    }

    if (workloadRow.status !== "ready" && workloadRow.status !== "created") {
      return {
        phase: "Degraded",
        ready: 0,
        warming: 0,
        detail: `Workload "${workloadName}" is in status "${workloadRow.status}"`,
      };
    }

    const workloadId = workloadRow.workloadId as WorkloadId;

    // 2. Check current pool depth (warming + ready)
    const currentDepth = deps.poolManager.getPoolDepth(workloadId);
    const warmingCount = deps.db
      .select({ instanceId: instances.instanceId })
      .from(instances)
      .where(
        and(
          eq(instances.workloadId, workloadId),
          eq(instances.poolStatus, "warming"),
        ),
      )
      .all().length;

    // 3. Replenish if under target (getPoolDepth counts only ready; replenish checks warming+ready)
    if (currentDepth + warmingCount < targetSize) {
      await deps.poolManager.replenish(workloadId);
    }

    const readyCount = deps.poolManager.getPoolDepth(workloadId);
    const newWarmingCount = deps.db
      .select({ instanceId: instances.instanceId })
      .from(instances)
      .where(
        and(
          eq(instances.workloadId, workloadId),
          eq(instances.poolStatus, "warming"),
        ),
      )
      .all().length;

    return {
      phase: "Healthy",
      ready: readyCount,
      warming: newWarmingCount,
    };
  } catch (err) {
    return {
      phase: "Error",
      ready: 0,
      warming: 0,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
```

- [ ] **Step 4: Run all pool controller tests**

```sh
bun test apps/operator/src/pool-controller.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```sh
git add apps/operator/src/pool-controller.ts apps/operator/src/pool-controller.test.ts
git commit -m "fix(operator): real warming count in pool status; add error detail to pool controller"
```

---

### Task 9: Clean up dead secretResolver; wire internal API server (issues 8, 14)

**Files:**
- Modify: `apps/operator/src/bootstrap.ts`

Two issues: (1) `secretResolver` is constructed and suppressed with `void` but never passed to any manager. It's dead code with a misleading comment. (2) `createInternalApi` is defined but `Bun.serve` is never called — the health/stats server is effectively dead.

- [ ] **Step 1: Remove dead `secretResolver` construction, add TODO comment**

In `apps/operator/src/bootstrap.ts`, replace:

```typescript
// Secret resolver for K8s-native credential resolution (used by network credential injection)
const secretResolver = new KubeSecretResolver({
  apiUrl: config.apiUrl,
  headers: config.token ? { Authorization: `Bearer ${config.token}` } : {},
  namespace: config.namespace,
  caCert: config.caCert,
});
void secretResolver; // wired into credential flows when network.credentials is set
```

With:

```typescript
// TODO: wire KubeSecretResolver into InstanceManager / TenantManager once those managers
// accept a SecretResolver for network.credentials injection.
```

Also remove the `KubeSecretResolver` import if it becomes unused. Check whether it's still used anywhere else in the file first.

- [ ] **Step 2: Wire `createInternalApi` into `Bun.serve`**

At the bottom of `startOperator`, after `await elector.start()` (which blocks), add the server start before the `elector.start()` call so it runs concurrently. Add the following import at the top of the file:

```typescript
import { createInternalApi } from "./internal-api";
```

In `startOperator`, before `await elector.start()`:

```typescript
// Internal HTTP server (health + stats endpoints)
const internalApi = createInternalApi({ instanceManager, db });
const apiPort = Number(process.env.INTERNAL_API_PORT ?? 9090);
Bun.serve({ fetch: internalApi.fetch, port: apiPort });
log.info({ port: apiPort }, "internal API server listening");
```

- [ ] **Step 3: Run all operator tests**

```sh
bun test apps/operator/ --timeout 30000
```

Expected: all pass.

- [ ] **Step 4: Commit**

```sh
git add apps/operator/src/bootstrap.ts
git commit -m "fix(operator): remove dead secretResolver; wire internal API into Bun.serve"
```

---

### Task 10: Fix deployment.yaml replicas and rbac.yaml ClusterRole→Role (issues 10, 17)

**Files:**
- Modify: `apps/operator/deploy/deployment.yaml`
- Modify: `apps/operator/deploy/rbac.yaml`

Two manifest issues: (1) `replicas: 2` with `emptyDir` DB means each pod has an independent ephemeral DB — the non-leader's DB is dead weight and recovery runs on every pod. Set to `replicas: 1` until a proper HA DB strategy is implemented. (2) `ClusterRole`+`ClusterRoleBinding` grants access across all namespaces; use `Role`+`RoleBinding` scoped to the `boilerhouse` namespace for least privilege.

- [ ] **Step 1: Fix deployment.yaml**

In `apps/operator/deploy/deployment.yaml`, change:

```yaml
spec:
  replicas: 2
```

To:

```yaml
spec:
  replicas: 1
  # replicas > 1 requires a shared persistent DB (not emptyDir). Leader election ensures only
  # one replica runs controllers, but each replica rebuilds its own DB on start. Keep at 1
  # until a PVC-backed or external DB is introduced.
```

- [ ] **Step 2: Fix rbac.yaml — convert ClusterRole+ClusterRoleBinding to Role+RoleBinding**

Replace `apps/operator/deploy/rbac.yaml` with:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: boilerhouse-operator
  namespace: boilerhouse
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: boilerhouse-operator
  namespace: boilerhouse
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
kind: RoleBinding
metadata:
  name: boilerhouse-operator
  namespace: boilerhouse
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: boilerhouse-operator
subjects:
  - kind: ServiceAccount
    name: boilerhouse-operator
    namespace: boilerhouse
```

- [ ] **Step 3: Commit**

```sh
git add apps/operator/deploy/deployment.yaml apps/operator/deploy/rbac.yaml
git commit -m "fix(operator): set replicas:1 until HA DB; downscope RBAC to Role+RoleBinding"
```

---

### Task 11: Verify full test suite passes (all issues)

- [ ] **Step 1: Run all unit tests**

```sh
bun test packages/ apps/ --timeout 30000
```

Expected: all pass. If any fail, fix before proceeding.

- [ ] **Step 2: Confirm no TypeScript errors**

```sh
cd apps/operator && bunx tsc --noEmit
```

Expected: no errors. Fix any that appear.

- [ ] **Step 3: Commit any final fixes**

If TypeScript errors required changes:

```sh
git add -p
git commit -m "fix(operator): resolve type errors from review fixes"
```
