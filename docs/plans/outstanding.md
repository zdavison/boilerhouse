# Outstanding Work

Combined tracker for all unimplemented, partially-wired, and planned items.
Items ordered by priority within each tier.

---

## Tier 1 — Must-have before production

### 1. Container Hardening (caps, RO root, no-new-privileges)

**Priority:** Critical
**Risk:** T1 — container escape via kernel exploit. Reducing syscall surface and
dropping capabilities blocks most known escape techniques.

**Current state:** No seccomp profile, no capability dropping, no read-only root.
Containers get Podman's default capability set including `CAP_SYS_CHROOT`,
`CAP_SETUID`, `CAP_SETGID`.

**Work:**
- Add `cap_drop`, `cap_add`, `seccomp_profile_path`, `read_only_filesystem`,
  `no_new_privileges` to `ContainerCreateSpec` and `buildCreateBody()`
- Set in `PodmanRuntime.create()`: drop ALL, add minimal set, RO root, no-new-privs
- Enforce in `boilerhouse-podmand` `validateContainerSpec()` as policy
- Ship `deploy/seccomp.json` with ~300 syscall whitelist

**Cons:**
- Read-only root breaks workloads that write outside declared `overlay_dirs` tmpfs
  mounts — images expecting writable `/tmp`, `/var` etc. need those paths pre-declared.
- Custom seccomp profiles are fragile; a missing syscall silently breaks workloads
  with hard-to-debug failures.

**Files:** `client.ts`, `runtime.ts`, `validate.ts`, `deploy/seccomp.json` (new)

---

### 2. Container Runs as Non-Root User

**Priority:** Critical
**Risk:** T1 — running as root inside the container makes many escape exploits
easier (`CAP_SYS_ADMIN` in user namespace, `/proc` manipulation).

**Current state:** No `user` field set — process runs as whatever the image's
`USER` directive says (usually root).

**Work:**
- Default `user: "65534:65534"` (nobody/nogroup) on container create
- Add optional `user` field to `WorkloadConfig.entrypoint` for overrides
- Enforce default in daemon policy

**Cons:**
- Many container images assume root (apt install, writing to `/root`, binding
  low ports). Forces workload authors to pre-configure images for UID 65534.
- May break existing golden snapshots created as root.

**Files:** `workload.ts`, `runtime.ts`, `validate.ts`

> CONCLUSION: This one will break too many workloads. We cant do it.

---

### 3. Container Network Isolation

**Priority:** Critical
**Risk:** T2, T3 — containers can reach each other and the host. A malicious
agent can scan the host, hit the API, or probe other containers.

**Current state:** Containers with `network.access !== "none"` get default Podman
bridge networking. All containers share the same bridge. No firewall rules.

**Work:**
- One Podman network per container (`bh-<instanceId>`, `/30` subnet)
- Subnet allocator (`10.89.0.0/16`, ~16K subnets)
- `createNetwork`/`removeNetwork` methods through full stack
  (PodmanClient → ContainerBackend → DaemonBackend → boilerhouse-podmand)
- Per-container network in create/destroy/restore flows
- nftables rules blocking cross-container and container-to-host traffic
- Setup script `scripts/setup-nftables.sh`

**Cons:**
- Most complex item — touches 6+ files across 3 layers plus host-level config.
- Host-level nftables rules may conflict with existing firewall rules.
- `/30` subnets limit pool to ~16K containers.
- CRIU restore needs checkpoint config rewriting for new network names.

**Files:** `client.ts`, `backend.ts`, `daemon-backend.ts`, `runtime.ts`,
`boilerhouse-podmand/main.ts`, `subnet-allocator.ts` (new),
`deploy/nftables-boilerhouse.conf` (new), `scripts/setup-nftables.sh` (new)

> CONCLUSION: This one must be done. Otherwise containers can see each other.

---

### 4. Data Overlay Restore

**Priority:** Critical
**Category:** Core functionality gap

**Current state:** `TenantDataStore` exists with `saveOverlay()`/`restoreOverlay()`,
the DB has a `dataOverlayRef` column, and `TenantManager.claim()` has a dedicated
"cold+data" branch — but the overlay path is never passed through to the runtime.
The path stops at `TenantDataStore.restoreOverlay()`.

**Work:**
1. Extend `Runtime.restore()` to accept optional overlay/mounts param
2. In PodmanRuntime, mount the ext4 image at the workload's `overlay_dirs`
   path after CRIU restore
3. Thread overlay path: `claim()` → `restoreAndClaim()` →
   `InstanceManager.restoreFromSnapshot()` → `runtime.restore()`

**Cons:**
- Modifying the `Runtime` interface affects all implementations (fake, kubernetes).
- Mounting ext4 images post-CRIU-restore is untested — may need `podman restore`
  flags or manual mount.

**Files:** `tenant-manager.ts`, `instance-manager.ts`, `core/runtime.ts`,
`runtime-podman/runtime.ts`, `tenant-data.ts`

> CONCLUSION: Needs more thought. What if we got rid of the overlay feature? Do we really need it? What does it provide?

---

## Tier 2 — Should-have before GA

### 5. PID Namespace Isolation

**Priority:** High
**Risk:** T2 — with shared PID namespace, processes in one container can see
(and potentially `ptrace`) processes in others.

**Current state:** Podman defaults to per-container PID namespaces, but this
is not explicitly configured.

**Work:** Set `pidns: { nsmode: "private" }` in container create spec.

**Cons:** Near-zero. Risk is only that Podman already defaults to this, making
it a no-op that gives false confidence.

**Files:** `client.ts`, `runtime.ts`

> CONCLUSION: Do it.

---

### 6. Snapshot Expiry & Garbage Collection

**Priority:** High
**Category:** Core functionality gap

**Current state:** The snapshots table has an `expiresAt` column that is never
written or read. Old snapshots accumulate on disk indefinitely.

**Work:**
- Set `expiresAt` when creating tenant snapshots
- Add periodic GC pass that deletes expired snapshots from DB and disk

**Cons:**
- GC deleting snapshots while a restore is in flight could cause data loss —
  needs coordination with snapshot manager.
- Choosing the right TTL is workload-dependent.

**Files:** `snapshot-manager.ts`, `schema.ts`

> CONCLUSION: Let's implement it.

---

### 7. Rate Limiting on API

**Priority:** High
**Risk:** T5, T7 — an attacker can flood the claim endpoint, exhausting
container resources.

**Current state:** `ResourceLimiter` checks max instance count but does not
rate-limit API calls.

**Work:** Per-key in-memory sliding window in auth middleware.
Claim: 10 req/min, writes: 60 req/min, reads: 300 req/min.

**Cons:**
- In-memory state lost on restart.
- Single-node only — no coordination for multi-node.
- Could block legitimate burst operations (e.g. bulk claim).

**Files:** `auth-middleware.ts`

> CONCLUSION: This shouldn't be an issue, as boilerhouse really shouldn't be used externally.
>             However, triggers are a risk. Triggers should allow rate limit to be configured on them.

---

### 8. Audit Log for Security Events

**Priority:** High
**Risk:** Post-breach investigation — no record of API calls, auth failures,
or denied operations.

**Current state:** `ActivityLog` records domain events (claim, release) but not
raw API calls or auth failures.

**Work:** Structured JSON-lines log via pino recording auth failures (401/403),
tenant-scoped operations with key ID, container lifecycle events.

**Cons:**
- Adds write I/O on every request.
- Log files need rotation/management or grow unbounded.
- Risk of logging sensitive data (tokens, tenant payloads) if not carefully scoped.

**Files:** `auth-middleware.ts`, `server.ts`

> CONCLUSION: No need for now.

---

### 9. Disk and I/O Resource Limits

**Priority:** Medium
**Risk:** T7 — container fills host disk or saturates I/O, degrading all tenants.

**Current state:** CPU and memory limits enforced. `disk_gb` is parsed but not
enforced. No I/O bandwidth limits.

**Work:**
- Map `disk_gb` to Podman's `--storage-opt size=<N>G`
- Add `blkio_weight` for proportional I/O scheduling

**Cons:**
- Requires XFS backing filesystem with `metacopy=on` — not all deployments use XFS.
- `blkio_weight` only works with cgroups v2 + specific I/O scheduler.
- Deployment-specific prerequisites make this fragile.

**Files:** `client.ts`, `runtime.ts`

> CONCLUSION: disk_gb should be parsed and passed to podman. Let's not do the rest.

---

### 10. Watch Dirs for Idle Detection

**Priority:** Medium
**Category:** Core functionality gap

**Current state:** `workload.idle.watch_dirs` is accepted by schema but nothing
monitors filesystem changes. `IdleMonitor.reportActivity(mtime)` exists but
nothing calls it. Idle detection is purely timeout-based.

**Work:** Either implement guest-side agent / host-side `podman exec stat`
polling, or remove the field.

**Cons:**
- Guest-side agent adds a dependency workload images must include.
- Host-side polling via `podman exec` is expensive per-container.
- If not implemented, should remove the field to stop misleading users.

**Files:** `idle-monitor.ts`, `workload.ts`

> CONCLUSION: This is a critical feature. We want to allow hibernating containers if they are idle automatically, its one of the main parts of boilerhouse. Let's consider and plan how this should work ideally.

---

### 11. HTTP_PROXY on Restored Containers ✓ DONE

Both runtimes already inject `HTTP_PROXY=http://localhost:18080`, which is the
stable DNS name approach. `localhost` resolves correctly in the shared pod
network namespace on both Podman and Kubernetes, so restored containers always
reach the Envoy sidecar at the same address regardless of when the snapshot was
taken. No further work required.

---

## Tier 3 — Nice-to-have / defense-in-depth

### 12. User Namespace Remapping

**Priority:** Medium

Run containers with `userns: "auto"` so root inside maps to unprivileged UID
on host. Prevents most container escape CVEs from gaining real root.

**Cons:** Known compatibility issues with CRIU checkpoint/restore — may break
snapshotting. Requires host-side `/etc/subuid` configuration.

> CONCLUSION: Write test script first to see if this does break CRIU, if it doesn't, lets implement.

---

### 13. AppArmor / SELinux Profile

**Priority:** Low

Custom mandatory access control profile restricting mounts, `/proc` access,
`/sys` writes, kernel module loading.

**Cons:** Distribution-specific (AppArmor on Ubuntu, SELinux on RHEL). Can't
ship one profile that works everywhere. Maintenance-heavy.

> CONCLUSION: Don't do.

---

### 14. Encrypted Snapshots at Rest

**Priority:** Low

AES-256-GCM encryption of snapshot archives using per-snapshot key derived
from server secret + snapshot ID.

**Cons:** CPU overhead on every snapshot/restore (potentially GB-size memory
dumps). Losing the server secret makes all snapshots unrecoverable. Only
protects against host-level disk access, which is already game-over.

> CONCLUSION: Don't do (but are we already doing it? i thought we were)

---

### 15. Container Image Allowlist

**Priority:** Low

Only permit images from a configured registry allowlist. Enforce in
`PodmanRuntime.ensureImage()` before `pullImage()`.

**Cons:** Restricts workload author flexibility. Allowlist maintenance burden.
Doesn't prevent malicious code inside allowed images.

> CONCLUSION: Don't do.

---

## Candidates for Removal

### 16. Bind Mounts

`BindMountSchema` is defined and validated in workload config but no runtime
mounts them. If `overlay_dirs` (tmpfs) covers all use cases, this is misleading
API surface that silently does nothing.

**If keeping:** Implement `type: "bind"` entries in `spec.mounts`. Security risk —
host paths exposed to containers running arbitrary code. Daemon allowlist helps
but misconfiguration could expose sensitive host directories.

**If removing:** Breaking change for any workload configs referencing `bind_mounts`.

> CONCLUSION: Remove.

---

### 17. Workload `metadata` Field

`Record<string, unknown>` — stored in DB, echoed in activity logs, never
queried or acted on. Remove unless a concrete use case emerges.

**If removing:** Breaking change if external systems rely on it in the API response.
Low risk since nothing reads it.

> CONCLUSION: Keep.

---

## Completed Items

| # | Item | Notes |
|---|------|-------|
| — | API Authentication (opt-in) | Single static key via `BOILERHOUSE_API_KEY`. All `/api/v1` routes (except `/health`) and `/ws` gated when set. |
| — | WebSocket Authentication | Token validated on `/ws?token=` when auth enabled. Tenant-scoped event filtering deferred (single shared key makes it unnecessary). |

---

## Recommended Implementation Order

| Phase | Items | Rationale |
|-------|-------|-----------|
| 1 | 1, 2, 5 | Container hardening + non-root + PID ns. Smallest, self-contained, always-on. |
| 2 | 3 | Network isolation. Largest single item, requires new infra plumbing. |
| 3 | 4, 6 | Data overlay restore + snapshot GC. Core functionality gaps. |
| 4 | 7, 8 | Rate limiting + audit log. Operational maturity. |
| 5 | 9, 10, 11 | Resource limits, watch dirs, proxy fix. Polish. |
| 6 | 16, 17 | Decide: implement or remove bind mounts and metadata. |
| — | 12–15 | Defense-in-depth. As needed based on threat assessment. |
