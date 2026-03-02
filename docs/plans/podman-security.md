# Podman Multi-Tenant Security Plan

## Status: PLANNED (Tier 1 implementation ready)

## Context

Boilerhouse is being prepared for production as a multi-tenant container platform. Tenants
run AI agents that write and execute arbitrary code inside their containers. The primary threat
is **cross-tenant breach** — one tenant's agent escaping its container to access another
tenant's container, data, or the host.

This plan builds on top of `podman-hardening.md` (items 1–6) and addresses the remaining gaps
identified during a full codebase security review. Items are ordered by blast radius and
grouped into tiers.

### Deployment Model

Boilerhouse is typically deployed within a private network with no external access. The
expected pattern is that an upstream API server talks to Boilerhouse over a private
network — no tokens, keys, or passwords; network topology is the trust boundary.

```
┌─────────────────────────────────────────────────────────────────┐
│ Private network                                                 │
│                                                                 │
│  Upstream API server  ──────→  Boilerhouse API  ──→  Podman    │
│  (handles end-user auth)       (trusts caller)                  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

However, operators may want to **expose the dashboard** to external networks (e.g. for
monitoring or admin access). In that case, the Boilerhouse API itself needs authentication
to prevent unauthorized access. API auth is therefore opt-in — off by default for private
deployments, enabled when the API is network-reachable.

### Architecture (Post-Refactor)

The runtime has a two-tier architecture:

```
API Server (apps/api)  →  PodmanRuntime  →  DaemonBackend  →  boilerhoused (apps/boilerhoused)  →  PodmanClient  →  Podman API
```

- **`PodmanRuntime`** (`packages/runtime-podman/src/runtime.ts`) builds `ContainerCreateSpec` and delegates to a `ContainerBackend`.
- **`DaemonBackend`** (`packages/runtime-podman/src/daemon-backend.ts`) sends HTTP requests over Unix socket to `boilerhoused`.
- **`boilerhoused`** (`apps/boilerhoused/src/main.ts`) validates specs via `validateContainerSpec()` and calls `PodmanClient` to talk to Podman's Libpod API.
- **`PodmanClient`** (`packages/runtime-podman/src/client.ts`) builds the raw Libpod JSON body via `buildCreateBody()`.

Security enforcement happens at **two layers**: `PodmanRuntime.create()` sets security fields on the spec, and `boilerhoused.validateContainerSpec()` enforces them as policy.

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
│                Boilerhouse API                      │
│  (private network: trusts caller)                   │
│  (exposed dashboard: must authenticate)             │
└─────────────────────────────────────────────────────┘
```

### Threat actors

| Actor            | Capability                                                  | Applies when              |
|------------------|-------------------------------------------------------------|---------------------------|
| Malicious agent  | Arbitrary code exec inside container (root or unprivileged) | Always                    |
| Curious tenant   | Calls the API with a valid token; tries to access other data| Dashboard exposed         |
| Network peer     | Can reach the API port; no token                            | Dashboard exposed         |

In the typical private-network deployment, the upstream API server is the only caller
and is trusted. The "curious tenant" and "network peer" threats only apply when the
dashboard or API is exposed beyond the private network.

### Critical paths to defend

| ID  | Attack                                     | Current status          | Deployment     |
|-----|--------------------------------------------|-------------------------|----------------|
| T1  | Container escape via kernel exploit        | Partial (no seccomp)    | Always         |
| T2  | Cross-container network access             | **Not enforced**        | Always         |
| T3  | Container reaches host services / API      | **Not enforced**        | Always         |
| T4  | API: tenant A operates on tenant B's data  | **No auth at all**      | Exposed only   |
| T5  | API: unauthenticated caller has full access| **No auth at all**      | Exposed only   |
| T6  | Snapshot memory dump exfiltration          | Partial (see hardening) | Always         |
| T7  | Resource exhaustion DoS against other tenants | Partial (no disk/IO)| Always         |

---

## Tier 1 — Must-have before production

### 1. API Authentication (opt-in)

**Risk:** T4, T5 — when the API or dashboard is exposed beyond the private network,
anyone who can reach it can claim, release, destroy, and enumerate all tenants and
instances.

**Current state:** Zero authentication. All routes are open. This is correct for
private-network deployments where the upstream API server is the sole trusted caller.

**When needed:** When the dashboard is exposed to external networks, or when multiple
untrusted callers share the same Boilerhouse deployment.

**Fix:** Add opt-in API key authentication as Elysia middleware (`beforeHandle` hook
on the `/api/v1` group). Disabled by default. Enabled when a bootstrap key is
configured or any API key exists in the database. Each API consumer gets a key scoped
to a set of tenants.

```
Authorization: Bearer bh_live_<key>
```

#### Schema — `api_keys` table

New table in `packages/db/src/schema.ts`:

| Column          | Type                      | Notes                                    |
|-----------------|---------------------------|------------------------------------------|
| `key_id`        | TEXT PK                   | `apk_...` prefix                         |
| `key_hash`      | TEXT                      | SHA-256 of the full key                  |
| `tenant_scope`  | jsonObject<string[] \| "*"> | Tenant ID prefixes or `"*"` for admin  |
| `description`   | TEXT                      | Human label                              |
| `created_at`    | INTEGER (epoch ms)        |                                          |
| `revoked_at`    | INTEGER (epoch ms)        | NULL until revoked                       |

Generate migration `0006_*.sql`.

#### Auth helpers — `apps/api/src/auth.ts`

| Function                              | Purpose                                               |
|---------------------------------------|-------------------------------------------------------|
| `generateApiKey()`                    | Returns `{ key: "bh_live_<32hex>", keyId, keyHash }` |
| `hashApiKey(key)`                     | SHA-256 hex                                           |
| `parseBearer(header)`                 | Extracts `bh_live_*` from `Authorization: Bearer ...` |
| `lookupApiKey(db, keyHash)`           | DB lookup, check not revoked → `AuthContext \| null`  |
| `isInScope(auth, tenantId)`           | `"*"` matches all; prefix-match for scoped keys      |
| `isAdmin(auth)`                       | `tenantScope === "*"`                                 |
| `filterByScope(auth, items, getTenantId)` | Filters list results                             |

```typescript
interface AuthContext {
  keyId: string;
  tenantScope: string[] | "*";
}
```

#### Auth middleware — `apps/api/src/routes/auth-middleware.ts`

- `derive` to parse/validate token → `{ auth: AuthContext | null }`
- `onBeforeHandle` to reject 401 if null
- When `authEnabled=false` (default): returns synthetic admin context — existing tests unaffected
- Health endpoint `/api/v1/health` exempt

#### Scope checking — `apps/api/src/routes/scope-check.ts`

- `checkTenantScope(auth, tenantId, set)` → `{ error } | null`
- `checkAdminScope(auth, set)` → `{ error } | null`

#### Route enforcement

| Route file             | Changes                                                     |
|------------------------|-------------------------------------------------------------|
| `routes/tenants.ts`    | Scope check on `:id`, filter on `GET /tenants`              |
| `routes/instances.ts`  | Scope check on `:id` (via instance tenantId), filter list   |
| `routes/snapshots.ts`  | Filter by tenantId                                          |
| `routes/secrets.ts`    | Scope check on tenant `:id`                                 |
| `routes/activity.ts`   | Filter by tenantId                                          |
| `routes/workloads.ts`  | Admin check on POST/DELETE                                  |
| `routes/nodes.ts`      | Admin check                                                 |
| `routes/system.ts`     | Admin check on `/stats`                                     |

Instances with null `tenantId` (pre-claim) require admin scope.

#### Key management routes — `apps/api/src/routes/auth-routes.ts`

- `POST /api/v1/auth/keys` — admin only, returns plaintext key once
- `GET /api/v1/auth/keys` — admin only, lists keys (no hashes)
- `DELETE /api/v1/auth/keys/:keyId` — admin only, soft-revokes

#### Wiring

- `apps/api/src/routes/deps.ts` — add `authEnabled?: boolean`
- `apps/api/src/app.ts` — `.use(authMiddleware(deps.db, deps.authEnabled))` before route plugins inside `/api/v1` group. Add `.use(authRoutes(deps))`.

#### Bootstrap + test updates

`apps/api/src/server.ts`:
- If `BOILERHOUSE_API_KEY` env var set → seed bootstrap admin key at startup (idempotent)
- Set `authEnabled: true` when `BOILERHOUSE_API_KEY` is set or any key exists in DB
- When unset (default): auth disabled, all callers trusted (private-network deployment)

`apps/api/src/test-helpers.ts`:
- `createTestApp(opts?)` accepts `{ authEnabled?: boolean }`. Default `false`.
- `apiRequest()` accepts optional `token` option.

`apps/api/src/e2e/e2e-helpers.ts`:
- Seed admin key, return `adminToken`
- `api()` includes `Authorization` header
- WS connections use `?token=<adminToken>`

---

### 2. WebSocket Authentication + Tenant-Scoped Events (opt-in)

**Risk:** T4, T5 — when auth is enabled, the `/ws` endpoint must also be gated,
otherwise it leaks all domain events (tenant IDs, instance IDs, state changes) to
unauthenticated clients.

**Current state:** `ws.ts` subscribes every connection to the global `EventBus` and
sends all events. This is correct for private-network deployments.

**When needed:** Whenever API auth (Item 1) is enabled.

**Fix:**

1. When auth is enabled, require an API key as a query parameter on WS upgrade:
   `/ws?token=bh_live_...`. Validate the same way as HTTP auth. Reject with 401 if
   invalid. When auth is disabled, allow all connections (current behavior).
2. When auth is enabled, filter events: only send events where the event's `tenantId`
   is in the connection's `tenant_scope`. Admin keys (`"*"`) see all events.

```typescript
function shouldSendEvent(auth: AuthContext, event: DomainEvent): boolean {
  if (auth.tenantScope === "*") return true;
  if ("tenantId" in event && event.tenantId) return isInScope(auth, event.tenantId);
  return false;
}
```

**Code changes:**
- `apps/api/src/routes/ws.ts` — validate token in `upgrade`/`open()` handler, store scope on
  `ws.data`, filter in the event handler.

---

### 3. Container Network Isolation

**Risk:** T2, T3 — containers can reach each other and the host network. A malicious
agent can scan the host, hit the API server, or probe other containers.

**Current state:** When `network.access !== "none"`, containers get default Podman
bridge networking. All containers share the same bridge. No iptables rules prevent
inter-container or container-to-host traffic.

#### 3a. One Podman network per container

Methods flow through the full stack:

**`PodmanClient`** (`packages/runtime-podman/src/client.ts`):
- Add `createNetwork(spec)` → `POST /libpod/networks/create`
- Add `removeNetwork(name)` → `DELETE /libpod/networks/{name}` (idempotent)
- Add `networks` field to `ContainerCreateSpec`
- Update `buildCreateBody()` to emit `networks`

**`ContainerBackend`** (`packages/runtime-podman/src/backend.ts`):
- Add `createNetwork(name, subnet)` and `removeNetwork(name)` to interface

**`DaemonBackend`** (`packages/runtime-podman/src/daemon-backend.ts`):
- Add `createNetwork()` → `POST /networks` to boilerhoused
- Add `removeNetwork()` → `DELETE /networks/{name}` to boilerhoused

**`boilerhoused`** (`apps/boilerhoused/src/main.ts`):
- Add `POST /networks` handler → calls `client.createNetwork()`
- Add `DELETE /networks/:name` handler → calls `client.removeNetwork()`
- Validate network spec (name must match `bh-*` pattern)

Use a `/30` subnet (4 IPs: network, gateway, container, broadcast) so each container
is alone on its bridge:

```
POST /libpod/networks/create
{
  "name": "bh-<instanceId>",
  "driver": "bridge",
  "internal": false,
  "subnets": [{ "subnet": "10.89.X.0/30" }]
}
```

Pass the network name in the container create spec:

```typescript
spec.networks = { [`bh-${instanceId}`]: {} };
```

Clean up the network on `destroy()`.

#### 3b. Subnet allocator

New file `packages/runtime-podman/src/subnet-allocator.ts`:

Allocates `/30` subnets from `10.89.0.0/16` (16K subnets). In-memory counter + free list.

#### 3c. Per-container network in create/destroy/restore

`packages/runtime-podman/src/runtime.ts`:

`ManagedContainer` gains `networkName?` and `subnetCidr?`.

**create()** when `network.access !== "none"`:
1. `subnetAllocator.allocate()` → get subnet CIDR
2. `backend.createNetwork("bh-<instanceId>", subnet)`
3. `spec.networks = { ["bh-<instanceId>"]: {} }`

**destroy()**:
1. Remove container (existing)
2. `backend.removeNetwork(networkName)`
3. `subnetAllocator.free(cidr)`

**restore()** when snapshot has exposed ports:
1. Allocate subnet, `backend.createNetwork("bh-<instanceId>", subnet)`
2. Extend `rewriteCheckpointPorts()` → `rewriteCheckpointConfig()` to also rewrite network name in `config.dump`
3. Restore container

#### 3d. Block cross-container and container-to-host traffic with nftables

New file `deploy/nftables-boilerhouse.conf`:

```nft
table inet boilerhouse {
  chain forward {
    type filter hook forward priority 0; policy accept;
    ct state established,related accept
    iifname "bh-*" udp dport 53 accept
    iifname "bh-*" tcp dport 53 accept
    iifname "bh-*" oifname "bh-*" drop          # cross-container
    iifname "bh-*" ip daddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 169.254.0.0/16 } drop
    iifname "bh-*" accept                         # internet
  }
  chain input {
    type filter hook input priority 0; policy accept;
    iifname "bh-*" tcp dport 38080 accept         # proxy port
    iifname "bh-*" ct state established,related accept
    iifname "bh-*" drop                            # all other host access
  }
}
```

New file `scripts/setup-nftables.sh` — installs rules, supports `--dry-run`.

---

### 4. Container Hardening (seccomp + capabilities + read-only root)

**Risk:** T1 — a malicious agent exploiting kernel vulnerabilities to escape the container.
Reducing the syscall surface and dropping capabilities makes most known escape techniques
non-viable.

**Current state:** No seccomp profile, no capability dropping, no read-only root.
Containers get Podman's default capability set, which includes `CAP_SYS_CHROOT`,
`CAP_SETUID`, `CAP_SETGID`, etc.

#### Security fields on `ContainerCreateSpec`

`packages/runtime-podman/src/client.ts` — add to spec and `buildCreateBody()`:

```typescript
cap_drop?: string[];
cap_add?: string[];
seccomp_profile_path?: string;
read_only_filesystem?: boolean;
no_new_privileges?: boolean;
```

#### Set in `PodmanRuntime.create()`

`packages/runtime-podman/src/runtime.ts`:

```typescript
spec.cap_drop = ["ALL"];
spec.cap_add = ["CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID",
                "SETGID", "SETUID", "NET_BIND_SERVICE"];
spec.read_only_filesystem = true;
spec.no_new_privileges = true;
```

Read-only root works with existing `overlay_dirs` tmpfs mounts — writable dirs are tmpfs, everything else is immutable.

#### Enforce in daemon policy

`apps/boilerhoused/src/validate.ts`:

```typescript
// Force hardening fields regardless of what the caller sent
sanitized.privileged = false;
sanitized.cap_drop = ["ALL"];
sanitized.cap_add = spec.cap_add ?? ["CHOWN", "DAC_OVERRIDE", ...]; // allow override for specific workloads
sanitized.read_only_filesystem = true;
sanitized.no_new_privileges = true;
```

#### Seccomp profile

New file `deploy/seccomp.json` — whitelist of ~300 syscalls blocking `mount`, `ptrace`,
`bpf`, `kexec_load`, `init_module`, `open_by_handle_at`, etc.

Not configured in the spec by default (Podman's built-in default is fine). The deploy
script installs the custom profile and `boilerhoused` can be configured to apply it
via config.

---

### 5. Container Runs as Non-Root User

**Risk:** T1 — even inside the container, running as root makes many exploits easier
(e.g. `CAP_SYS_ADMIN` inside a user namespace, `/proc` manipulation).

**Current state:** No `user` field set on container create — process runs as whatever
the image's `USER` directive says (usually root).

**Fix:** Set `user: "65534:65534"` (nobody/nogroup) on container create. Workloads
that need a specific user can declare it in the workload config:

```typescript
// in workload.ts entrypoint schema
user: Type.Optional(Type.String({ minLength: 1 }))
```

Also add to `WorkloadConfig.entrypoint`.

#### Runtime

`packages/runtime-podman/src/runtime.ts`:
```typescript
spec.user = workload.entrypoint?.user ?? "65534:65534";
```

#### Daemon policy

`apps/boilerhoused/src/validate.ts`:
```typescript
sanitized.user = spec.user ?? "65534:65534";
```

---

## Tier 1 — Implementation Order

| Step | Phase | Description                                          | Effort |
|------|-------|------------------------------------------------------|--------|
| 1    | 1     | Non-root user — schema + runtime + daemon            | Small  |
| 2    | 1     | Container hardening — caps, RO root, no-new-privs    | Small  |
| 3    | 1     | Seccomp profile (`deploy/seccomp.json`)              | Small  |
| 4    | 2     | `api_keys` table + migration                         | Small  |
| 5    | 2     | Auth helpers + unit tests                            | Small  |
| 6    | 2     | Auth middleware plugin + tests                       | Medium |
| 7    | 2     | Scope check helpers + route enforcement              | Medium |
| 8    | 2     | Auth key management routes                           | Small  |
| 9    | 2     | WebSocket auth + event filtering                     | Medium |
| 10   | 2     | Bootstrap key, server.ts, test helper updates        | Small  |
| 11   | 3     | Subnet allocator                                     | Small  |
| 12   | 3     | Network methods: PodmanClient + Backend + Daemon + DaemonBackend | Medium |
| 13   | 3     | Per-container networks in create/destroy/restore     | Medium |
| 14   | 3     | nftables config + setup script                       | Small  |
| 15   | 3     | Integration tests for network isolation              | Small  |

Phase 1 = Container Hardening (Items 4 & 5) — smallest, self-contained. Always-on.
Phase 2 = API Authentication (Items 1 & 2) — largest, most files touched. Opt-in (for exposed dashboards).
Phase 3 = Container Network Isolation (Item 3) — requires new infra plumbing. Always-on.

---

## Tier 1 — Test Plan (TDD)

Tests are written first, then features implemented to make them pass.

### Phase 1 tests

`packages/core/src/workload.test.ts`:
- `validateWorkload()` accepts entrypoint with user field
- `resolveWorkloadConfig()` passes user through

`packages/runtime-podman/src/runtime.test.ts`:
- `create() sets user to "65534:65534" by default`
- `create() uses workload entrypoint.user when specified`
- `create() drops all capabilities and adds minimal set`
- `create() sets read_only_filesystem: true`
- `create() sets no_new_privileges: true`

`apps/boilerhoused/src/validate.test.ts`:
- Policy enforces user default
- Policy enforces cap_drop/cap_add
- Policy enforces read_only_filesystem

### Phase 2 tests

`apps/api/src/auth.test.ts`:
- `generateApiKey()` returns key with `bh_live_` prefix
- `hashApiKey()` produces consistent SHA-256 hex
- `parseBearer()` extracts key from valid header
- `parseBearer()` returns null for missing/malformed headers
- `isInScope()` matches admin `"*"` scope
- `isInScope()` prefix-matches tenant IDs
- `filterByScope()` filters items to scoped tenants only

`apps/api/src/routes/auth-middleware.test.ts`:
- Returns 401 for missing Authorization header
- Returns 401 for revoked key
- Returns 401 for invalid key
- Allows request with valid key
- Skips auth when `authEnabled=false`
- Exempts health endpoint

`apps/api/src/routes/auth-routes.test.ts`:
- `POST /auth/keys` creates key and returns plaintext once
- `GET /auth/keys` lists keys without hashes
- `DELETE /auth/keys/:keyId` soft-revokes
- Non-admin keys get 403

### Phase 3 tests

`packages/runtime-podman/src/subnet-allocator.test.ts`:
- Allocates sequential /30 subnets
- Frees and reuses subnets
- Throws when pool exhausted

`packages/runtime-podman/src/runtime.test.ts`:
- `create() calls createNetwork with bh-<instanceId>`
- `create() passes networks field in spec`
- `destroy() calls removeNetwork`
- `create() skips network for access "none"`

`packages/runtime-podman/src/runtime.integration.test.ts`:
- Per-container network created/destroyed
- Two containers cannot ping each other

---

## Tier 1 — File Summary

### New files

| File                                                   | Purpose                          |
|--------------------------------------------------------|----------------------------------|
| `apps/api/src/auth.ts`                                 | Auth types, helpers, key gen     |
| `apps/api/src/auth.test.ts`                            | Auth helper unit tests           |
| `apps/api/src/routes/auth-middleware.ts`                | Elysia auth plugin               |
| `apps/api/src/routes/auth-middleware.test.ts`           | Auth middleware tests            |
| `apps/api/src/routes/auth-routes.ts`                   | Key CRUD endpoints               |
| `apps/api/src/routes/auth-routes.test.ts`              | Key management tests             |
| `apps/api/src/routes/scope-check.ts`                   | Scope checking helpers           |
| `packages/runtime-podman/src/subnet-allocator.ts`      | /30 subnet allocator             |
| `packages/runtime-podman/src/subnet-allocator.test.ts` | Subnet allocator tests           |
| `deploy/seccomp.json`                                  | Custom seccomp profile           |
| `deploy/nftables-boilerhouse.conf`                     | nftables isolation rules         |
| `scripts/setup-nftables.sh`                            | nftables install script          |

### Modified files

| File                                                   | Changes                                     |
|--------------------------------------------------------|---------------------------------------------|
| `packages/core/src/workload.ts`                        | Add `user` to entrypoint schema             |
| `packages/core/src/workload.test.ts`                   | Tests for user field                        |
| `packages/runtime-podman/src/client.ts`                | Security + network fields on spec/body      |
| `packages/runtime-podman/src/backend.ts`               | Add `createNetwork`, `removeNetwork`        |
| `packages/runtime-podman/src/daemon-backend.ts`        | Network method client calls                 |
| `packages/runtime-podman/src/runtime.ts`               | Security fields, per-container networks     |
| `packages/runtime-podman/src/runtime.test.ts`          | Tests for hardening + networks              |
| `packages/runtime-podman/src/runtime.integration.test.ts` | Network isolation integration tests      |
| `packages/db/src/schema.ts`                            | Add `apiKeys` table                         |
| `apps/boilerhoused/src/main.ts`                        | Network endpoints                           |
| `apps/boilerhoused/src/validate.ts`                    | Enforce hardening as policy                 |
| `apps/boilerhoused/src/validate.test.ts`               | Policy enforcement tests                    |
| `apps/api/src/app.ts`                                  | Wire auth middleware + routes               |
| `apps/api/src/routes/deps.ts`                          | Add `authEnabled?`                          |
| `apps/api/src/routes/ws.ts`                            | WS auth + event filtering                   |
| `apps/api/src/routes/tenants.ts`                       | Scope checks                                |
| `apps/api/src/routes/instances.ts`                     | Scope checks                                |
| `apps/api/src/routes/snapshots.ts`                     | Scope filtering                             |
| `apps/api/src/routes/secrets.ts`                       | Scope checks                                |
| `apps/api/src/routes/activity.ts`                      | Scope filtering                             |
| `apps/api/src/routes/workloads.ts`                     | Admin checks                                |
| `apps/api/src/routes/nodes.ts`                         | Admin checks                                |
| `apps/api/src/routes/system.ts`                        | Admin checks                                |
| `apps/api/src/test-helpers.ts`                         | Support `authEnabled` option                |
| `apps/api/src/server.ts`                               | Bootstrap key, enable auth                  |
| `apps/api/src/e2e/e2e-helpers.ts`                      | Seed admin key, pass tokens                 |

---

## Tier 1 — Verification

1. **Unit tests:** `bun test --recursive` — all existing + new pass
2. **Auth:** Create app with `authEnabled: true`, verify 401/403 for unauthorized
3. **Hardening:** Integration test — `podman inspect` verifies caps, read_only, user
4. **Network:** Integration test — two containers cannot ping; cannot reach host API
5. **E2E:** Full suite with auth — `bun test apps/api/src/e2e/ --timeout 120000`

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

> **Note:** Moved to Tier 1 Item 4 (container hardening). `no_new_privileges: true` is
> now set as part of the standard hardening spec.

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

## Relationship to existing plans

- **`podman-hardening.md` items 1–5:** Complementary. Those items protect the
  host-side privilege boundary (HMAC, socket permissions, capability bounding).
  This plan protects the tenant-side boundaries (auth, network, container escape).
  Both are needed.

- **`podman-hardening.md` item 6 (runtimed proxy):** Supersedes nothing here.
  The runtimed proxy protects against a compromised API server abusing the Podman
  socket. This plan protects against compromised containers and unauthenticated API
  callers. They are orthogonal.
