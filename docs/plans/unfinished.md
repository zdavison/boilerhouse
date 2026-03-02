# Unfinished & Unimplemented Features

Audit of partially-wired, silently-ignored, or missing features.
Items grouped by category and prioritised within each group.

---

## 1. Core Functionality Gaps

### 1.1 Data Overlay Restore (high priority)

`TenantDataStore` exists with `saveOverlay()` and `restoreOverlay()`, the DB
has a `dataOverlayRef` column on tenants, and `TenantManager.claim()` has a
dedicated "cold+data" branch — but the overlay path is **never passed through
to the runtime**.

- `apps/api/src/tenant-data.ts` — save/restore overlay paths
- `apps/api/src/tenant-manager.ts:106-118` — resolves `overlayPath`, calls
  `restoreAndClaim()` without passing it
- `packages/core/src/runtime.ts` — `restore(ref, instanceId)` has no overlay param
- `packages/runtime-podman/src/runtime.ts` — no mount logic for ext4 overlays

**To fix:**
1. Extend `Runtime.restore()` to accept an optional overlay/mounts param.
2. In PodmanRuntime, mount the ext4 image at the workload's `overlay_dirs`
   path after CRIU restore (or via podman restore flags).
3. Thread the overlay path from `claim()` → `restoreAndClaim()` →
   `InstanceManager.restoreFromSnapshot()` → `runtime.restore()`.

### 1.2 Bind Mounts (medium priority)

`BindMountSchema` is defined and validated in the workload config, but no
runtime ever mounts them.

- `packages/core/src/workload.ts` — schema with `host`, `guest`, `readonly`
- `packages/runtime-podman/src/runtime.ts:create()` — handles `overlay_dirs`
  but ignores `bind_mounts`

**To fix:** Add `type: "bind"` entries to `spec.mounts` in `create()`.
Alternatively, remove from the schema if overlays cover all use cases.

### 1.3 Watch Dirs for Idle Detection (medium priority)

`workload.idle.watch_dirs` is accepted by the schema but nothing monitors
filesystem changes inside the guest.

- `packages/core/src/workload.ts` — `watch_dirs` field
- `apps/api/src/idle-monitor.ts` — has `reportActivity(mtime)` but nothing
  calls it

Idle detection is purely timeout-based today. Watch dirs are silently ignored.

**To fix:** Either implement a guest-side agent that reports fs activity, or
remove the field to avoid misleading configs.

### 1.4 `disk_gb` Resource Limit (medium priority)

`workload.resources.disk_gb` is parsed and validated but never passed to
Podman as a storage limit.

- `packages/core/src/workload.ts` — field definition
- `packages/runtime-podman/src/runtime.ts:create()` — sets CPU/memory, ignores disk

**To fix:** Map to Podman's `storage_opts` or `--storage-opt size=Xg`.
Alternatively, remove if tmpfs size caps on overlay_dirs are sufficient.

### 1.5 Snapshot Expiry & Garbage Collection (medium priority)

The snapshots table has an `expiresAt` column that is never written or read.
Old snapshots accumulate on disk indefinitely.

- `packages/db/src/schema.ts` — `expiresAt` column on snapshots

**To fix:** Set `expiresAt` when creating tenant snapshots. Add a periodic GC
pass that deletes expired snapshots from both DB and disk.

### 1.6 HTTP_PROXY on Restored Containers (low priority)

`proxyAddress` is injected into env vars during `create()` for golden
bootstrap, but restored containers inherit whatever was baked into the
snapshot. If the proxy address changes, restored containers have a stale value.

- `packages/runtime-podman/src/runtime.ts:117-121` — injection at create time

**To fix:** Re-inject proxy env vars after CRIU restore, or use a stable
internal DNS name that doesn't change.

---

## 2. Security (pre-production)

These are tracked in more detail in `podman-security.md` and
`secret-gateway.md`. Listed here for completeness.

### 2.1 API Authentication (critical)

No auth middleware exists. All routes are open to anyone with network access.
No API key table, no tenant-scoped authorization.

### 2.2 WebSocket Authentication (high)

`/ws` upgrade has no token validation. All connected clients receive all
events including tenant IDs and state transitions.

### 2.3 Container Hardening (high)

Missing from `PodmanRuntime.create()`:
- `cap_drop: ["ALL"]`
- `read_only_filesystem: true`
- `no_new_privileges: true`
- seccomp profile
- explicit `pidns: { nsmode: "private" }`

### 2.4 Network Isolation (high)

Containers on the default bridge can reach each other.
`network.access: "restricted"` with `allowlist` is parsed but no firewall
rules are applied.

### 2.5 Snapshot Archive Permissions (medium)

Archives written without explicit `0o600` mode. Snapshot directory not
verified `0o700` at startup. Archives contain full process memory.

---

## 3. Candidates for Removal

### 3.1 Workload `metadata` Field

`Record<string, unknown>` — stored in DB, echoed in activity logs, never
queried or acted on. Remove unless a concrete use case emerges.

- `packages/core/src/workload.ts` — field definition
- `packages/db/src/schema.ts` — stored in workload config blob

### 3.2 Bind Mounts (if overlays suffice)

If data overlays + `overlay_dirs` cover all mount needs, the `bind_mounts`
schema field is misleading API surface that silently does nothing. See 1.2.
