# Parallel Golden Restores

## Problem

CRIU cannot restore the same checkpoint archive concurrently. Today,
`TenantManager.serializedRestore()` enforces a per-snapshot mutex so
that all restores from the same golden snapshot are queued one-at-a-time.

For workloads with burst claim patterns (e.g. 10 tenants claiming the
same workload simultaneously), this serialization is the dominant
latency bottleneck — the Nth tenant waits for N-1 restores to complete
sequentially.

Note: this is a Podman/CRIU-specific limitation. The Kubernetes runtime
doesn't use CRIU — it cold-boots a fresh pod and restores filesystem
overlay data. But the mutex applies to *all* snapshot types today, so
it also unnecessarily serializes K8s restores.

---

## Prior Art

How other systems solve parallel restore from a golden snapshot:

### Firecracker (AWS Lambda, Fly.io, CodeSandbox)

[github.com/firecracker-microvm/firecracker](https://github.com/firecracker-microvm/firecracker)

Firecracker `mmap`s the snapshot memory file with `MAP_PRIVATE`, giving
each restored microVM its own copy-on-write view of the same file.
Concurrent restores share clean pages via the kernel page cache and
only allocate memory for pages that diverge. This is the gold standard
for parallel snapshot restore — zero copy overhead, kernel-managed CoW.

AWS Lambda's SnapStart extends this with **userfaultfd (UFFD)**: a
userspace page-fault handler loads pages on-demand from a remote
store, so the snapshot doesn't even need to be fully local. CodeSandbox
uses the same UFFD approach to clone running VMs in ~2 seconds
([blog post](https://codesandbox.io/blog/how-we-clone-a-running-vm-in-2-seconds)).

Firecracker operates at the VM level, not container/CRIU level, so
`MAP_PRIVATE` mmap is natural. CRIU restores processes, not VMs, and
doesn't expose the same mmap-based restore path.

**References:**
- [Snapshot support docs](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md)
- [Page fault handling docs](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/handling-page-faults-on-snapshot-resume.md)
- [On-demand Container Loading in AWS Lambda (USENIX ATC'23)](https://www.usenix.org/system/files/atc23-brooker.pdf)
- [Restoring Uniqueness in MicroVM Snapshots](https://arxiv.org/abs/2102.12892)

### LXD / Incus (btrfs/ZFS CoW clones)

[linuxcontainers.org/incus/docs/main/reference/storage_drivers](https://linuxcontainers.org/incus/docs/main/reference/storage_drivers/)

Incus snapshots a golden container's filesystem using ZFS snapshots or
btrfs subvolumes. New containers are created via `zfs clone` or
`btrfs subvolume snapshot` — instant, zero-copy, fully parallel. Each
clone shares base blocks and only writes deltas.

**This is the closest analogue to our proposed Option A.** The
difference is that Incus clones the *filesystem*, not a CRIU checkpoint
archive. Our approach applies the same CoW-clone idea to the checkpoint
tar archive itself.

### Kata Containers (VM templating)

[github.com/kata-containers/kata-containers](https://github.com/kata-containers/kata-containers/blob/main/docs/how-to/what-is-vm-templating-and-how-do-I-use-it.md)

Kata creates a "template VM" and maps its kernel/initramfs/agent memory
as **readonly shared mappings**. Each new VM clone gets a writeable
overlay. Parallel clones share the read-only base, similar to
Firecracker's MAP_PRIVATE approach but at the hypervisor level.

### gVisor (Modal)

[gvisor.dev/docs/user_guide/checkpoint_restore](https://gvisor.dev/docs/user_guide/checkpoint_restore/)

gVisor checkpoints its entire userspace kernel state to a file. Each
restore creates a completely independent sandbox — no CRIU involved, so
there's no shared-archive contention. Modal uses this for sub-second
container startup, including GPU memory snapshots via NVIDIA's CUDA C/R.

**Reference:** [Modal memory snapshots blog](https://modal.com/blog/mem-snapshots)

### Podman + CRIU

[podman.io/docs/checkpoint](https://podman.io/docs/checkpoint)

Podman supports `podman container restore <checkpoint-1> <checkpoint-2>`
— restoring multiple *different* checkpoints in parallel. Each restore
creates an independent container. Checkpoints can be stored as OCI
images and pushed to registries.

However, restoring the *same* checkpoint archive concurrently from the
same path is not supported — which is exactly our bottleneck.

### CRaC (Coordinated Restore at Checkpoint)

[crac.org](https://crac.org/) /
[github.com/crac](https://github.com/crac)

CRaC checkpoints a warmed JVM using CRIU under the hood. Each restore
creates an independent JVM process from the checkpoint files. The
snapshot files are read-only inputs — CRaC doesn't address concurrent
restore from the same archive specifically, but since each JVM is
independent, multiple restores can run if the files aren't locked.
Restore latency: ~40ms vs seconds for cold JVM start.

### Academic Work

- **REAP** (ASPLOS '22) — Records the memory working set during first
  invocation, prefetches only those pages on restore via userfaultfd.
  61–96% memory reduction.
  ([PDF](https://marioskogias.github.io/docs/reap.pdf))
- **FaaSnap** (EuroSys '22) — 3.5× faster than REAP via optimized
  snapshot loading with Firecracker.
  ([PDF](https://www.sysnet.ucsd.edu/~voelker/pubs/faasnap-eurosys22.pdf))
- **Spice** (2025) — Shows both CRIU and VM approaches bottleneck on
  OS metadata restoration; proposes dedicated kernel interfaces.
  ([arXiv](https://arxiv.org/html/2509.14292v1))

### Summary of Patterns

| Pattern | Used By | Mechanism |
|---|---|---|
| MAP_PRIVATE mmap (CoW) | Firecracker, Lambda | Kernel CoW on memory-mapped snapshot; each VM gets private dirty pages |
| Userfaultfd (UFFD) | Firecracker, CodeSandbox, REAP | Userspace page-fault handler loads pages on-demand |
| ZFS/btrfs clone | LXD/Incus | Filesystem-level CoW; instant zero-copy clones |
| VM template (readonly shared) | Kata Containers | Shared readonly memory + writeable overlay per clone |
| Independent restore | CRIU, Podman, CRaC, gVisor | Each restore reads checkpoint and creates independent process tree |

### Takeaway for Boilerhouse

The MAP_PRIVATE/UFFD approaches (Firecracker, Lambda) are the most
elegant but require VM-level control we don't have — we use CRIU via
Podman, which operates on process trees not memory-mapped VM images.

The closest applicable pattern is **LXD/Incus's filesystem CoW clone**:
copy the snapshot archive using btrfs/reflink before each restore, so
each CRIU invocation sees its own file. This is what Option A proposes.

---

## Options Considered

### Option A: Copy-Before-Restore (recommended)

Copy the golden snapshot archive before each restore. Each concurrent
restore gets its own copy, so there is no contention on the original.

Use the fastest copy mechanism available on the volume:
btrfs subvolume snapshot > cp --reflink > full cp.

| | |
|---|---|
| **Pros** | Simple, restores are fully parallel, no idle resource cost, minimal code change (~5 files), works on any filesystem with graceful degradation |
| **Cons** | On non-CoW filesystems (ext4), falls back to full copy which adds I/O latency per restore. Requires btrfs/XFS-reflink on the snapshot volume for near-instant copies. |
| **Complexity** | Low |
| **Latency improvement** | Restores run in parallel; per-restore latency unchanged. On CoW: near-zero overhead. On ext4 fallback: adds copy time (~seconds for large archives). |

### Option B: Pre-Warmed Instance Pool

Maintain a pool of N already-restored instances per workload. Claims
grab a warm instance instead of restoring on-demand. A background
replenisher restores new instances into the pool (serialized, off the
hot path).

| | |
|---|---|
| **Pros** | Zero restore latency on claim — instances are already running. Best possible claim speed. |
| **Cons** | Idle resource consumption (CPU, memory, disk) for pre-warmed instances. Requires pool sizing logic (min/max/scale-up triggers). More complex lifecycle — pool instances need health checks, eviction, and replenishment. Cold-start latency shifts to pool replenishment (which is still serialized). |
| **Complexity** | High — new `InstancePool` component, background replenisher, pool sizing config, health monitoring. |
| **Latency improvement** | Claims are instant. But pool replenishment still serialized unless combined with Option A. |

### Option C: Snapshot Replica Fan-Out

Pre-copy the golden archive to N replicas on disk at golden-creation
time (`golden-<id>-replica-0.tar.gz`, ..., `golden-<id>-replica-N.tar.gz`).
Concurrent restores each pick a different replica, giving N-way
parallelism.

| | |
|---|---|
| **Pros** | No per-restore copy overhead — replicas are created ahead of time. Simple concurrency model (round-robin or least-recently-used). |
| **Cons** | Disk space scales linearly with replica count (N × archive size). Must choose N upfront — under-provisioned = still queuing, over-provisioned = wasted disk. Replicas must be re-created when golden is updated. |
| **Complexity** | Medium — replica management in `SnapshotManager`, cleanup on golden rotation. |
| **Latency improvement** | Up to N-way parallel. Still has restore latency per claim. |

### Option D: Hardlink per Restore

Use `ln` to hardlink the archive to a unique path before each restore.
Instant, no extra disk (same inode).

| | |
|---|---|
| **Pros** | Instant, zero disk overhead, works on any filesystem. |
| **Cons** | **Does not solve the problem.** Hardlinks share the same underlying inode and data blocks — CRIU still contends on the same file. Only works if CRIU's issue is with the *path* rather than the *file content*, which is not guaranteed and not documented. Would need testing to validate. |
| **Complexity** | Trivial if it works. |
| **Latency improvement** | Unknown — depends on whether CRIU's concurrency limitation is path-based or inode-based. |

### Recommendation

**Option A (Copy-Before-Restore)** is the best balance of simplicity,
correctness, and performance. It directly removes the mutex with
minimal architectural change. On a btrfs or reflink-capable volume the
copy is near-instant and free; on ext4 it degrades gracefully to a
full copy (still parallel, just slower per-restore).

Option B (pool) could be layered on top later if claim latency (not
just parallelism) becomes the bottleneck — and it would benefit from
Option A for its own background replenishment.

Option D (hardlink) is worth a quick spike to test whether CRIU's
limitation is path-based. If it works, it's strictly better than
Option A since it has zero overhead on any filesystem. But it's
unproven, so Option A is the safe bet.

---

## Implementation Plan (Option A)

### Design Principles

1. **Runtime-agnostic.** The copy-before-restore logic lives in
   `InstanceManager` (above the `Runtime` interface), not inside any
   specific runtime. The user and the rest of the API layer don't know
   or care that CRIU is the reason — they just see snapshots restoring
   in parallel.

2. **Both runtimes benefit.** Podman (CRIU) needs this for correctness
   (concurrent archive access). Kubernetes doesn't use CRIU, but its
   `restore()` reads `overlay.tar.gz` + `workload.json` from the
   snapshot directory — copying the directory also protects against
   any future filesystem contention and removes the mutex that
   unnecessarily serializes K8s restores today.

3. **Copy the snapshot directory, not just one file.** Podman snapshots
   are a single file (`{snapshotDir}/{id}/checkpoint.tar.gz`), but
   Kubernetes snapshots are a directory (`{snapshotDir}/{id}/` with
   `workload.json` + `overlay.tar.gz`). To support both uniformly, we
   copy the entire snapshot directory.

4. **No changes to the `Runtime` interface.** The `Runtime.restore()`
   signature stays the same. `InstanceManager` passes a modified
   `SnapshotRef` with paths pointing to the copy. Each runtime sees a
   unique directory and operates normally.

### Step 1: `SnapshotCopier` (new: `packages/core/src/snapshot-copier.ts`)

A utility that copies a snapshot directory to a unique temporary
location using the fastest available filesystem mechanism.

```ts
export type CopyStrategy = "btrfs-snapshot" | "reflink" | "full-copy";

export interface CopyHandle {
  /** Root directory of the copied snapshot. */
  dir: string;
  /** Clean up the copy. Must be called after restore completes. */
  cleanup: () => Promise<void>;
}

export class SnapshotCopier {
  readonly strategy: CopyStrategy;

  /**
   * Probe the snapshot volume at `baseDir` and select the fastest
   * copy strategy. Call once at startup.
   */
  static async detect(baseDir: string): Promise<SnapshotCopier>;

  /**
   * Copy an entire snapshot directory to a unique temp location.
   *
   * @param snapshotDir - e.g. `/data/snapshots/abc123/`
   * @returns Handle with the copied directory path and a cleanup fn.
   */
  async copy(snapshotDir: string): Promise<CopyHandle>;
}
```

**Strategy detection** (`detect()`, called once at server startup):

1. Create a small test file in `{baseDir}/.probe/`.
2. Try `cp --reflink=always` to a second file. If exit code 0 →
   strategy is `"reflink"`.
3. If that fails, check if baseDir is a btrfs subvolume
   (`btrfs subvolume show`). If so → `"btrfs-snapshot"`.
4. If both fail → `"full-copy"`.
5. Clean up probe files. Log the chosen strategy.

> btrfs-snapshot is tried second because it requires the source to be
> a subvolume, which is a stricter requirement. reflink works on any
> file within a btrfs or XFS-reflink volume.

**Copy implementation:**

All strategies copy the snapshot directory (not just a single file) to
`{baseDir}/.restore-copies/{uuid}/`:

| Strategy | Command | Cleanup |
|---|---|---|
| `reflink` | `cp -a --reflink=always {src}/ {dst}/` | `rm -rf {dst}` |
| `btrfs-snapshot` | `btrfs subvolume snapshot {src} {dst}` | `btrfs subvolume delete {dst}` |
| `full-copy` | `cp -a {src}/ {dst}/` | `rm -rf {dst}` |

The `-a` flag preserves structure (important for K8s snapshots with
multiple files). For reflink, `-a --reflink=always` copies the
directory tree with reflinked file contents.

**Noop mode:** Construct with `strategy: "none"` to skip copying
entirely. Returns the original dir and a no-op cleanup. Used when the
runtime doesn't need isolation (e.g. FakeRuntime in tests).

### Step 2: Changes to `InstanceManager`

**Constructor:**

```ts
export class InstanceManager {
  constructor(
    private readonly runtime: Runtime,
    private readonly db: DrizzleDb,
    private readonly activityLog: ActivityLog,
    private readonly nodeId: NodeId,
    private readonly snapshotCopier: SnapshotCopier,  // NEW
    private readonly eventBus?: EventBus,
    private readonly log?: Logger,
    private readonly secretStore?: SecretStore,
  ) {}
```

**`executeRestore()` — the only method that changes:**

Current flow:
1. Look up workload config
2. Build restore options
3. Call `this.runtime.restore(ref, instanceId, restoreOptions)`

New flow:
1. Look up workload config
2. Build restore options
3. **Copy the snapshot directory**
4. **Rewrite `ref.paths` to point at the copy**
5. Call `this.runtime.restore(ephemeralRef, instanceId, restoreOptions)`
6. **Clean up the copy (in `finally`)**

```ts
async executeRestore(
  ref: SnapshotRef,
  instanceId: InstanceId,
  workloadId: WorkloadId,
  tenantId: TenantId,
): Promise<InstanceHandle> {
  // ... existing workload lookup + restoreOptions ...

  // Derive the snapshot directory from the ref paths.
  // Podman: /data/snapshots/{id}/checkpoint.tar.gz → /data/snapshots/{id}/
  // K8s:    /data/snapshots/{id}/overlay.tar.gz    → /data/snapshots/{id}/
  const snapshotDir = dirname(ref.paths.vmstate);
  const copy = await this.snapshotCopier.copy(snapshotDir);

  // Rewrite paths to point at the copy
  const rebase = (original: string) =>
    join(copy.dir, basename(original));

  const ephemeralRef: SnapshotRef = {
    ...ref,
    paths: {
      vmstate: rebase(ref.paths.vmstate),
      memory: rebase(ref.paths.memory),
    },
  };

  let handle: InstanceHandle;
  try {
    handle = await this.runtime.restore(
      ephemeralRef, instanceId, restoreOptions,
    );
  } catch (err) {
    // ... existing error handling (destroy orphaned pod, etc.) ...
    throw err;
  } finally {
    await copy.cleanup();
  }

  // ... existing post-restore logic (transition, activity log) ...
  return handle;
}
```

**Why `dirname` + `basename` rebasing works for both runtimes:**

- Podman: `ref.paths.vmstate` = `/data/snapshots/abc/checkpoint.tar.gz`.
  `dirname` = `/data/snapshots/abc/`. Copy creates
  `/data/snapshots/.restore-copies/uuid/` with `checkpoint.tar.gz`
  inside. `rebase` → `/data/snapshots/.restore-copies/uuid/checkpoint.tar.gz`.

- Kubernetes: `ref.paths.vmstate` = `/data/snapshots/abc/overlay.tar.gz`.
  Same pattern. The `workload.json` alongside it is also in the copied
  directory. K8s runtime reads it via `join(ref.paths.memory, "..")` →
  `join("/data/snapshots/.restore-copies/uuid/overlay.tar.gz", "..")`
  → `/data/snapshots/.restore-copies/uuid/` — correct.

- FakeRuntime: `SnapshotCopier` is constructed with noop strategy.
  Paths unchanged. No filesystem operations.

**`restoreFromSnapshot()` also benefits** — it calls `executeRestore()`
internally, so the convenience method gets parallel restore for free.

### Step 3: Remove `serializedRestore()` from `TenantManager`

With each restore operating on its own copy, the per-snapshot mutex is
no longer needed.

**Delete:**
- `restoreLocks` property (line 53)
- `serializedRestore()` method (lines 384–406)

**Change `restoreAndClaim()`** (line 345):

```diff
- handle = await this.serializedRestore(ref.id, () =>
-   this.instanceManager.executeRestore(ref, prepared.instanceId, prepared.workloadId, tenantId),
- );
+ handle = await this.instanceManager.executeRestore(
+   ref, prepared.instanceId, prepared.workloadId, tenantId,
+ );
```

The 500ms post-failure cooldown also goes away — it was there for CRIU
overlay cleanup between serialized restores of the same archive. With
independent copies, there's nothing to clean up between restores.

### Step 4: Wire up in `server.ts`

At startup, after creating `snapshotDir`:

```ts
import { SnapshotCopier } from "@boilerhouse/core";

// Detect the fastest copy strategy for the snapshot volume
const snapshotCopier = await SnapshotCopier.detect(snapshotDir);
log.info({ strategy: snapshotCopier.strategy }, "Snapshot copy strategy detected");

// For FakeRuntime (tests), use noop copier
// const snapshotCopier = SnapshotCopier.noop();
```

Pass to `InstanceManager`:

```ts
const instanceManager = new InstanceManager(
  runtime, db, activityLog, nodeId,
  snapshotCopier,  // NEW
  eventBus, log, secretStore,
);
```

### Step 5: Startup cleanup of orphan copies

If the process crashes mid-restore, copy directories in
`.restore-copies/` may be left behind. Add a cleanup sweep at startup:

```ts
// In server.ts, after SnapshotCopier.detect():
await snapshotCopier.cleanupStale(maxAgeMs: 10 * 60 * 1000);
```

This deletes any entries in `{snapshotDir}/.restore-copies/` older
than 10 minutes. Safe because:
- Active copies are at most seconds old (restore duration)
- 10 minutes is well beyond any reasonable restore time
- Runs once at startup, not on a timer

### Step 6: FakeRuntime and tests

`FakeRuntime` doesn't touch the filesystem, so it doesn't need real
copies. Use a noop copier:

```ts
// In test setup:
const copier = SnapshotCopier.noop();
const instanceManager = new InstanceManager(
  fakeRuntime, db, activityLog, nodeId, copier,
);
```

`SnapshotCopier.noop()` returns a copier whose `copy()` returns the
original directory and a no-op cleanup. Strategy = `"none"`.

---

## Deployment Note: Hetzner

Hetzner dedicated servers and cloud VMs default to ext4, which does
not support reflinks. To get fast copies:

- Format the snapshot storage volume as **btrfs** (or XFS with
  `mkfs.xfs -m reflink=1`).
- On Hetzner Cloud: attach a volume, format as btrfs, mount at the
  snapshot storage path.
- Only the snapshot volume needs btrfs — the rest of the system stays
  on ext4.

Without btrfs/reflink, the system falls back to full `cp -a`. This
still enables parallel restores (the mutex is removed regardless), but
each restore pays the I/O cost of a full archive copy.

---

## File Changes

| File | Change |
|---|---|
| `packages/core/src/snapshot-copier.ts` | **New.** `SnapshotCopier` class: `detect()`, `noop()`, `copy()`, `cleanupStale()`. |
| `packages/core/src/index.ts` | Export `SnapshotCopier`, `CopyStrategy`, `CopyHandle`. |
| `apps/api/src/instance-manager.ts` | Add `snapshotCopier` constructor param. Use it in `executeRestore()` to copy-then-restore. |
| `apps/api/src/tenant-manager.ts` | Remove `restoreLocks`, `serializedRestore()`. Call `executeRestore()` directly in `restoreAndClaim()`. |
| `apps/api/src/server.ts` | Create `SnapshotCopier` at startup via `detect()`. Pass to `InstanceManager`. Call `cleanupStale()`. |

---

## Testing

### Unit tests (`packages/core/src/snapshot-copier.test.ts`)

- **Strategy detection:** mock shell commands to simulate btrfs,
  reflink, and fallback environments. Verify probe order and that the
  correct strategy is selected.
- **Copy + cleanup:** for each strategy, verify that `copy()` creates
  a new directory with the expected contents, and that `cleanup()`
  removes it.
- **Noop mode:** verify `noop()` returns original paths and cleanup
  is a no-op.
- **Stale cleanup:** create fake entries with old mtimes in
  `.restore-copies/`, call `cleanupStale()`, verify they're removed.

### Unit tests (`apps/api/src/tenant-manager.test.ts`)

- Update "concurrent claims from different tenants for same workload
  all succeed (serialized restore)" — it should still pass but now
  the test name should reflect that restores are parallel, not
  serialized. Optionally verify that restore calls overlap in time
  (start times of concurrent restores should be within ms of each
  other, not staggered by restore duration).

### Unit tests (`apps/api/src/instance-manager.test.ts`)

- New test: verify that `executeRestore()` calls `snapshotCopier.copy()`
  before `runtime.restore()`, and calls `cleanup()` in the finally
  block even when restore throws.
- New test: verify that the `SnapshotRef` passed to `runtime.restore()`
  has paths pointing to the copy directory, not the original.

### Integration test (podman)

- Set up a btrfs loopback volume as the snapshot dir (or skip if
  btrfs-progs not available).
- Create a golden snapshot, then fire N concurrent restores.
- Assert all N complete successfully and ran in parallel (wall time <
  N × single-restore time).

### E2E

- `multi-tenant-claim.e2e.test.ts` already tests concurrent claims —
  should pass without changes but run faster.

---

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| **Disk space from copies (full-copy fallback)** | Copies are ephemeral — cleaned up in `finally` immediately after restore. Only N copies exist simultaneously for N concurrent restores. Startup sweep catches orphans. |
| **btrfs/reflink detection wrong** | Strategy detection uses a real probe file write + copy, not mount-type sniffing. If the probe fails, we fall back gracefully to the next strategy. |
| **Cleanup failure leaves orphan copies** | `cleanupStale()` runs at startup, deleting `.restore-copies/` entries older than 10 minutes. |
| **K8s `workload.json` path derivation** | K8s runtime reads `workload.json` via `join(ref.paths.memory, "..")`. Since we copy the whole directory and rebase `ref.paths.memory` to `{copy}/overlay.tar.gz`, the `..` resolves to `{copy}/` which contains `workload.json`. Verified by the path rebasing logic. |
| **Tenant snapshots** | Per-tenant so contention is rare, but the copy path applies uniformly to all snapshot types. No special-casing needed. |
| **FakeRuntime in tests** | Noop copier means zero behavior change for existing unit tests. No filesystem operations. |

## Interaction with S3 Storage Plan

See `docs/plans/s3-storage.md`. The S3 plan introduces a `TieredStore`
with a local `DiskCache` and an `S3Backend`. This fundamentally changes
where snapshot data lives before restore.

### Current flow (local-only)

```
SnapshotRef.paths.vmstate → /data/snapshots/{id}/checkpoint.tar.gz
                              (always on local disk)
```

### Future flow (with TieredStore)

```
DB stores snapshotId (key only, no local path)
    ↓
TieredStore.get(snapshotId)
    ↓ cache hit: return local path
    ↓ cache miss: download from S3 → write to DiskCache → return local path
    ↓
SnapshotRef.paths.vmstate → /data/cache/snapshots/{id}/checkpoint.tar.gz
                              (resolved at restore time)
```

### How the two plans compose

The restore pipeline becomes a three-stage sequence:

```
1. TieredStore.get()     → ensures snapshot is on local disk (cache)
2. SnapshotCopier.copy() → copies cached snapshot to ephemeral dir
3. Runtime.restore()     → restores from the ephemeral copy
```

Each stage solves a distinct problem:

| Stage | Problem Solved |
|---|---|
| `TieredStore.get()` | Snapshot may not be on this node (S3 fetch + cache) |
| `SnapshotCopier.copy()` | CRIU can't restore the same archive concurrently |
| `Runtime.restore()` | Actually restore the container/VM from the archive |

### Concurrent cache miss: two dedup layers

When N tenants claim the same workload simultaneously and the golden
snapshot is cold (not in DiskCache):

1. **TieredStore dedup** (S3 plan's open question): the first
   `get(snapshotId)` downloads from S3; concurrent `get()` calls for
   the same key wait on a per-key promise. Result: one S3 download,
   one cached file.

2. **SnapshotCopier**: each of the N restores copies the cached file
   to its own ephemeral directory. Result: N independent copies, N
   parallel CRIU restores.

Without TieredStore dedup, each restore would independently download
from S3 — which *accidentally* gives each its own file and avoids CRIU
contention, but wastes N× bandwidth. With both layers in place, we get
one download + N cheap copies.

### Critical constraint: same filesystem

**`SnapshotCopier` uses reflink/btrfs for near-instant copies. Reflinks
only work within the same filesystem.** This means:

- `SNAPSHOT_CACHE_DIR` (from S3 plan) and the `.restore-copies/`
  directory (from this plan) **must be on the same volume**.
- If the S3 plan puts the DiskCache at `/data/cache/snapshots/` and
  SnapshotCopier puts copies at `/data/snapshots/.restore-copies/`,
  these must be the same mount. Otherwise reflink falls back to full
  copy.

**Recommendation:** SnapshotCopier should create `.restore-copies/`
as a sibling of the source directory, not relative to a fixed
`snapshotDir`. Since `copy()` receives the resolved local path from
TieredStore, it can derive the copies dir from the source path:

```ts
// snapshotDir = /data/cache/snapshots/{id}/
// copies land in /data/cache/snapshots/.restore-copies/{uuid}/
const copiesBase = join(dirname(snapshotDir), ".restore-copies");
```

This ensures copies are always on the same volume as the source,
regardless of where TieredStore's DiskCache is mounted.

### Strategy detection must probe the cache volume

With S3 storage, snapshots live in the cache dir, not `SNAPSHOT_DIR`.
Strategy detection at startup should probe **the volume where restores
actually happen** — which is `SNAPSHOT_CACHE_DIR` when S3 is enabled,
or `SNAPSHOT_DIR` when local-only.

```ts
const probeDir = s3Enabled ? snapshotCacheDir : snapshotDir;
const snapshotCopier = await SnapshotCopier.detect(probeDir);
```

### What if TieredStore already provides isolation?

A natural question: if `TieredStore.get()` downloads to a unique temp
path and then renames into the cache, couldn't we just skip the copier
and have each restore call `get()` which returns a unique download?

No — `get()` is designed to **dedup** concurrent requests and return
the same cached path. This is correct behavior for a cache (avoid
redundant downloads). The copier is still needed to fork the cached
file into per-restore copies.

Even if we changed `get()` to return unique copies, that would conflate
two concerns (caching vs. restore isolation) and break the cache's
ability to serve reads without re-downloading.

### Implementation order

These two plans can be implemented in either order:

**Option 1: Copier first (recommended)**
1. Implement SnapshotCopier against current local-only paths
2. Later, implement TieredStore — SnapshotCopier works unchanged
   because it operates on whatever local path it receives

**Option 2: TieredStore first**
1. Implement TieredStore — restores are still serialized (mutex
   remains) but snapshots are durable in S3
2. Later, add SnapshotCopier and remove the mutex

Option 1 is recommended because parallel restores are the more
pressing performance issue, and the copier is a smaller change.

### Changes to the S3 plan

When implementing the S3 plan, account for:

1. `SnapshotRef.paths` will point to cache paths (resolved by
   `TieredStore.get()`), not stable local paths. SnapshotCopier
   copies from these cache paths — no change needed in copier.

2. `cleanupStale()` must only clean `.restore-copies/`, never the
   cache entries. Cache eviction is DiskCache's responsibility.

3. TieredStore's `get()` must implement per-key promise dedup
   (already flagged as an open question in the S3 plan). Without it,
   concurrent claims of a cold snapshot trigger N redundant S3
   downloads.

---

## Open Questions

- Should we log a warning at startup if the strategy is `full-copy`?
  Operators on ext4 may not realize they're paying a full copy per
  restore.
- Should `SnapshotCopier` live in `packages/core/` or in a new
  `packages/snapshot-storage/` package? It has no runtime-specific
  dependencies but does shell out to `cp`/`btrfs`. Core seems fine
  given it already contains `FakeRuntime` and other utilities.
