# Podman Multi-Tenant Security Plan

## Context

Boilerhouse is being prepared for production as a multi-tenant container platform. Tenants
run AI agents that write and execute arbitrary code inside their containers. The primary threat
is **cross-tenant breach** — one tenant's agent escaping its container to access another
tenant's container, data, or the host.

This plan builds on top of `podman-hardening.md` (items 1–6) and addresses the remaining gaps
identified during a full codebase security review. Items are ordered by blast radius and
grouped into tiers.

---

## Threat Model

```
Tenant A's AI agent                        Tenant B's AI agent
  │ (arbitrary code execution)               │ (arbitrary code execution)
  ▼                                          ▼
┌──────────────────┐                ┌──────────────────┐
│ Container A      │                │ Container B      │
│ (should be       │───── X ───────│ (must not be     │
│  isolated)       │  must not     │  reachable)      │
└────────┬─────────┘  cross        └────────┬─────────┘
         │                                  │
         ▼                                  ▼
┌─────────────────────────────────────────────────────┐
│                   Host / Podman                     │
│         (must not be reachable from containers)     │
└─────────────────────┬───────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────┐
│                   API Server                        │
│   (must authenticate + authorize all requests)      │
└─────────────────────────────────────────────────────┘
```

### Threat actors

| Actor          | Capability                                                    |
|----------------|---------------------------------------------------------------|
| Malicious agent| Arbitrary code exec inside container (root or unprivileged)   |
| Curious tenant | Calls the API with a valid token; tries to access other data  |
| Network peer   | Can reach the API port; no token                              |

### Critical paths to defend

| ID  | Attack                                    | Current status         |
|-----|-------------------------------------------|------------------------|
| T1  | Container escape via kernel exploit        | Partial (no seccomp)   |
| T2  | Cross-container network access             | **Not enforced**       |
| T3  | Container reaches host services / API      | **Not enforced**       |
| T4  | API: tenant A operates on tenant B's data  | **No auth at all**     |
| T5  | API: unauthenticated caller has full access| **No auth at all**     |
| T6  | Snapshot memory dump exfiltration          | Partial (see hardening)|
| T7  | Resource exhaustion DoS against other tenants | Partial (no disk/IO) |

---

## Tier 1 — Must-have before production

### 1. API authentication

**Risk:** T4, T5 — anyone who can reach the API can claim, release, destroy, and
enumerate all tenants and instances.

**Current state:** Zero authentication. All routes are open. `RouteDeps` has no auth
service. `app.ts` applies only an error handler.

**Fix:** Add API key authentication as Elysia middleware (`beforeHandle` hook on the
`/api/v1` group). Each API consumer gets a key scoped to a set of tenants.

```
Authorization: Bearer bh_live_<key>
```

**Schema change:** New `api_keys` table:

| Column          | Type    | Notes                                    |
|-----------------|---------|------------------------------------------|
| `key_id`        | TEXT PK | Prefixed ID (`apk_...`)                  |
| `key_hash`      | TEXT    | SHA-256 of the full key                  |
| `tenant_scope`  | TEXT    | JSON array of tenant ID prefixes / `"*"` |
| `description`   | TEXT    | Human label                              |
| `created_at`    | INTEGER | Epoch ms                                 |
| `revoked_at`    | INTEGER | NULL until revoked                       |

**Middleware behaviour:**
1. Extract `Authorization: Bearer <key>` header.
2. SHA-256 hash the key, look up in `api_keys`.
3. If missing or revoked → 401.
4. Attach `authenticatedScopes` to the Elysia `store` / `derive` context.
5. On every tenant-scoped route, verify `tenantId` matches `tenant_scope`. If not → 403.

**Endpoints requiring tenant scoping:**

| Endpoint                          | Scope check                                |
|-----------------------------------|--------------------------------------------|
| `POST /tenants/:id/claim`        | `:id` in scope                             |
| `POST /tenants/:id/release`      | `:id` in scope                             |
| `GET  /tenants/:id`              | `:id` in scope                             |
| `GET  /tenants`                   | Filter to scoped tenants only              |
| `GET  /instances`                 | Filter to scoped tenant instances only     |
| `GET  /instances/:id`            | Instance's `tenantId` in scope             |
| `GET  /instances/:id/endpoint`   | Instance's `tenantId` in scope             |
| `POST /instances/:id/hibernate`  | Instance's `tenantId` in scope             |
| `POST /instances/:id/destroy`    | Instance's `tenantId` in scope             |
| `GET  /snapshots`                 | Filter to scoped tenants only              |

**Admin routes** (`GET /system/*`, `POST /workloads/*`, `GET /nodes/*`) require a key
with `tenant_scope: "*"`. Tenant-scoped keys cannot access them.

**Code changes:**
- New `packages/db/src/schema.ts` table + migration.
- New `apps/api/src/auth.ts` — middleware + helpers.
- `apps/api/src/app.ts` — apply auth middleware to `/api/v1` group.
- Every route file — inject tenant scope filter into DB queries.
- `apps/api/src/routes/deps.ts` — no change needed (auth is middleware, not a dep).

---

### 2. WebSocket authentication + tenant-scoped events

**Risk:** T4, T5 — the `/ws` endpoint broadcasts all domain events (tenant IDs, instance
IDs, state changes) to every connected client with no authentication.

**Current state:** `ws.ts` subscribes every connection to the global `EventBus` and
sends all events.

**Fix:**
1. Require an API key as a query parameter on WS upgrade: `/ws?token=bh_live_...`.
   Validate the same way as HTTP auth. Reject with 401 if invalid.
2. Filter events: only send events where the event's `tenantId` is in the
   connection's `tenant_scope`. Admin keys (`"*"`) see all events.

**Code changes:**
- `apps/api/src/routes/ws.ts` — validate token in `upgrade` handler, store scope on
  `ws.data`, filter in the event handler.

---

### 3. Container network isolation

**Risk:** T2, T3 — containers can reach each other and the host network. A malicious
agent can scan the host, hit the API server, or probe other containers.

**Current state:** When `network.access !== "none"`, containers get default Podman
bridge networking. All containers share the same bridge. No iptables rules prevent
inter-container or container-to-host traffic.

**Fix — per-container network namespace with firewall rules:**

**3a. One Podman network per container.**

Create a dedicated Podman network for each container at create time:

```
POST /libpod/networks/create
{
  "name": "bh-<instanceId>",
  "driver": "bridge",
  "internal": false,
  "subnets": [{ "subnet": "10.89.X.0/30" }]
}
```

Use a `/30` subnet (4 IPs: network, gateway, container, broadcast) so each container
is alone on its bridge. Pass the network name in the container create spec:

```typescript
spec.networks = { [`bh-${instanceId}`]: {} };
```

Clean up the network on `destroy()`.

**3b. Block container-to-host and cross-container traffic with nftables.**

After container start, add nftables rules:

```
table inet boilerhouse {
  chain forward {
    type filter hook forward priority 0; policy drop;

    # Allow established/related (return traffic for outbound connections)
    ct state established,related accept

    # Allow container → internet (via default route), block container → host
    iifname "bh-*" oifname != "bh-*" ip daddr != { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16 } accept

    # Everything else (container→container, container→host) is dropped
  }
}
```

This ensures:
- Containers cannot reach each other (different bridges, forward chain drops).
- Containers cannot reach the host's private IPs (API server, podman socket, etc).
- Containers can reach the internet (for `"outbound"` mode).
- For `"none"` mode: keep `nsmode: "none"` (no network namespace at all).
- For `"restricted"` mode: route through the ForwardProxy (see 3c).

**3c. Wire up the ForwardProxy for `"restricted"` mode.**

The `ForwardProxy` class exists in `apps/api/src/proxy/` but is not connected to
container lifecycle. For `restricted` workloads:

1. On container start: resolve the container's IP, call `proxy.addInstance(ip, allowlist)`.
2. Configure the container's `HTTP_PROXY` / `HTTPS_PROXY` env vars to point at the proxy.
3. Nftables rule for restricted containers: only allow traffic to the proxy port.
4. On destroy/hibernate: call `proxy.removeInstance(ip)`.

**Code changes:**
- `packages/runtime-podman/src/runtime.ts` — create/destroy per-container network.
- `packages/runtime-podman/src/client.ts` — add `createNetwork()`, `removeNetwork()`.
- `apps/api/src/instance-manager.ts` — call proxy registration on start/restore.
- `apps/api/src/server.ts` — instantiate `ForwardProxy`, pass to deps.
- New `scripts/setup-nftables.sh` — install the `boilerhouse` nftables table.
- New `deploy/boilerhouse-nftables.conf` — the ruleset.

---

### 4. Container hardening (seccomp + capabilities + read-only root)

**Risk:** T1 — a malicious agent exploiting kernel vulnerabilities to escape the container.
Reducing the syscall surface and dropping capabilities makes most known escape techniques
non-viable.

**Current state:** No seccomp profile, no capability dropping, no read-only root.
Containers get Podman's default capability set, which includes `CAP_SYS_CHROOT`,
`CAP_SETUID`, `CAP_SETGID`, etc.

**Fix — add security options to `buildCreateBody()`:**

```typescript
// In PodmanClient.buildCreateBody():
body.privileged = false;
body.read_only_filesystem = true;
body.cap_drop = ["ALL"];
body.cap_add = ["CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID",
                "SETGID", "SETUID", "NET_BIND_SERVICE"];
body.seccomp_profile_path = "/etc/boilerhouse/seccomp.json";
```

The seccomp profile is a whitelist of ~300 syscalls (matching Docker/Podman defaults but
explicitly blocking `mount`, `umount`, `pivot_root`, `ptrace`, `kexec_load`,
`init_module`, `finit_module`, `delete_module`, `bpf`, `userfaultfd`, `perf_event_open`,
`open_by_handle_at`, `personality`, `keyctl`). Profile stored in
`deploy/seccomp.json`.

Read-only root filesystem combined with the existing tmpfs overlay dirs means:
- Workloads can write to their declared overlay dirs.
- The root filesystem is immutable — no rootkit installation.

**Code changes:**
- `packages/runtime-podman/src/client.ts` — extend `ContainerCreateSpec` and
  `buildCreateBody()` with security fields.
- `packages/runtime-podman/src/runtime.ts` — set the security fields in `create()`.
- New `deploy/seccomp.json` — custom seccomp profile.

---

### 5. Container runs as non-root user

**Risk:** T1 — even inside the container, running as root makes many exploits easier
(e.g. `CAP_SYS_ADMIN` inside a user namespace, `/proc` manipulation).

**Current state:** No `user` field set on container create — process runs as whatever
the image's `USER` directive says (usually root).

**Fix:** Set `user: "65534:65534"` (nobody/nogroup) on container create. Workloads
that need a specific user can declare it in the workload TOML:

```toml
[entrypoint]
user = "1000:1000"
```

Add `user` field to `WorkloadSchema.entrypoint` and pass through to `ContainerCreateSpec`.
Default to `65534:65534` if not specified.

**Code changes:**
- `packages/core/src/workload.ts` — add `user` to entrypoint schema.
- `packages/runtime-podman/src/client.ts` — add `user` to spec + body.
- `packages/runtime-podman/src/runtime.ts` — set user from workload or default.

---

## Tier 2 — Should-have before GA

### 6. Disk and I/O resource limits

**Risk:** T7 — a container fills the host disk or saturates I/O, degrading all tenants.

**Current state:** CPU and memory limits are enforced via cgroups. `disk_gb` is
parsed but not enforced. No I/O bandwidth limits.

**Fix:**
- Disk: Use Podman's `--storage-opt size=<disk_gb>G` (requires `overlay` storage driver
  with `metacopy=on` and XFS backing). Add `storage_opts` to `ContainerCreateSpec`.
- I/O: Add `blkio_weight` to cgroup limits (proportional I/O scheduling). Each container
  gets equal weight.

**Code changes:**
- `packages/runtime-podman/src/client.ts` — add `storage_opts`, `blkio_weight` to spec.
- `packages/runtime-podman/src/runtime.ts` — set from workload resources.

---

### 7. No new privileges flag

**Risk:** T1 — `setuid` binaries inside the container can escalate to root even if the
container process starts as non-root.

**Fix:** Set `no_new_privileges: true` on container create. This prevents `execve` from
gaining privileges via setuid/setgid bits or file capabilities.

**Code changes:**
- `packages/runtime-podman/src/client.ts` — add to `buildCreateBody()`.

---

### 8. PID namespace isolation

**Risk:** T2 — with the default shared PID namespace, processes inside one container
can see (and potentially `ptrace`) processes in others.

**Current state:** Podman defaults to per-container PID namespaces, but this is not
explicitly configured.

**Fix:** Explicitly set `pidns: { nsmode: "private" }` in the container create spec
to prevent regressions.

---

### 9. Rate limiting on API

**Risk:** T5, T7 — an attacker with a valid key (or no key, before item 1 lands) can
flood the claim endpoint, exhausting container resources.

**Current state:** `ResourceLimiter` checks max instance count but does not rate-limit
API calls.

**Fix:** Add per-key rate limiting in the auth middleware:
- Claim: 10 req/min per key.
- Other writes: 60 req/min per key.
- Reads: 300 req/min per key.

Use a simple in-memory sliding window. No external dependency needed for single-node.

---

### 10. Audit log for security events

**Risk:** Post-breach investigation — if a breach occurs, there is no record of what
API calls were made.

**Current state:** `ActivityLog` records domain events (claim, release) but not raw
API calls, auth failures, or denied operations.

**Fix:** Add a security audit log (separate from activity log) that records:
- All auth failures (401, 403) with source IP and attempted key prefix.
- All tenant-scoped operations with the authenticated key ID.
- All container lifecycle events (create, destroy, snapshot, restore).

Write to a structured log file (JSON lines) via the existing pino logger.

---

## Tier 3 — Nice-to-have / defense-in-depth

### 11. User namespace remapping

Run containers with `userns: "auto"` so that root inside the container maps to an
unprivileged UID on the host. This prevents most container escape CVEs from gaining
real root. Requires podman >= 4.0 and `/etc/subuid` configuration.

Note: CRIU checkpoint/restore with user namespace remapping may have compatibility
issues. Test thoroughly before enabling.

### 12. AppArmor / SELinux profile

Apply a custom AppArmor profile (or SELinux context) to containers that restricts:
- Mounting filesystems
- Accessing `/proc/sysrq-trigger`, `/proc/kcore`, etc.
- Writing to `/sys`
- Loading kernel modules

Podman applies `container-default` AppArmor on most distros, but a custom profile
tailored to Boilerhouse workloads would be tighter.

### 13. Encrypted snapshots at rest

Snapshots contain full process memory (heap, stack, TLS state, API keys in flight).
Even with HMAC integrity (hardening item 1) and file permissions (hardening item 3),
disk access by a host-level attacker exposes them.

Encrypt snapshots with AES-256-GCM using a per-snapshot key derived from the server
secret + snapshot ID. Decrypt on restore.

### 14. Container image allowlist

Only permit images from a configured registry allowlist. Prevents workload definitions
from pulling arbitrary images that might contain exploits or bypass security controls.

Enforce in `PodmanRuntime.ensureImage()` before calling `pullImage()`.

---

## Implementation order

| Phase | Items | Effort  | Blocks production |
|-------|-------|---------|-------------------|
| 1     | 1, 2  | Medium  | Yes — no auth     |
| 2     | 3     | Medium  | Yes — no network isolation |
| 3     | 4, 5  | Small   | Yes — trivial container escape |
| 4     | 6, 7, 8, 9 | Small | No — hardening |
| 5     | 10    | Small   | No — observability |
| 6     | 11–14 | Medium  | No — defense in depth |

Phases 1–3 are **blocking for production**. A multi-tenant deployment without API
auth or network isolation is fundamentally unsafe regardless of other hardening.

---

## Relationship to existing plans

- **`podman-hardening.md` items 1–5:** Complementary. Those items protect the
  host-side privilege boundary (HMAC, socket permissions, capability bounding).
  This plan protects the tenant-side boundaries (auth, network, container escape).
  Both are needed.

- **`podman-hardening.md` item 6 (runtimed proxy):** Supersedes nothing here.
  The runtimed proxy protects against a compromised API server abusing the Podman
  socket. This plan protects against compromised containers and unauthenticated API
  callers. They are orthogonal.
