# Containerization Plan

## Context

Boilerhouse is a container orchestrator. The API server talks to a rootful Podman daemon
over a Unix socket, and a forward proxy injects credentials into outbound HTTP requests
from managed containers.

Currently everything runs on the host. We want to containerize the API, proxy, and
dashboard — leaving only the privileged Podman daemon as a host systemd service. The
key challenge is that managed containers need to reach the proxy. Today they use
`host.containers.internal` which requires host networking. Instead, we'll put the proxy
on a shared Podman network so containers reach it by DNS name.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Host                                                           │
│                                                                 │
│  ┌──────────────────────┐         boilerhouse network           │
│  │ podman system service│    ┌──────────────────────────────┐   │
│  │ (systemd, root)      │    │                              │   │
│  └──────┬───────────────┘    │  ┌─────────┐  ┌───────────┐ │   │
│         │ podman.sock        │  │   API    │  │   proxy   │ │   │
│         │                    │  │  :3000   │──│  :8080    │ │   │
│  ┌──────┴───────┐            │  │          │  │  ctrl     │ │   │
│  │ socket mount │────────────│──│          │  │  :9090    │ │   │
│  └──────────────┘            │  └─────────┘  └───────────┘ │   │
│                              │                     ▲        │   │
│                              │  ┌────┐ ┌────┐ ┌────┘  ┌──┐ │   │
│                              │  │wk1 │ │wk2 │ │wk3│  │db│ │   │
│                              │  └────┘ └────┘ └────┘  └──┘ │   │
│                              └──────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## Phases

### Phase 1: Extract proxy into `packages/proxy`

Move proxy code out of `apps/api/src/proxy/` into a standalone workspace package.

**Move files:**
- `apps/api/src/proxy/proxy.ts` → `packages/proxy/src/proxy.ts`
- `apps/api/src/proxy/matcher.ts` → `packages/proxy/src/matcher.ts`
- `apps/api/src/proxy/sni.ts` → `packages/proxy/src/sni.ts`
- All corresponding `.test.ts` files

**Create:**
- `packages/proxy/package.json` — `@boilerhouse/proxy`, no external deps
- `packages/proxy/tsconfig.json`
- `packages/proxy/src/index.ts` — barrel export

**Refactor `ForwardProxy`:**
- Remove `secretResolver` from config — proxy no longer resolves secrets
- Credential injection in `handleHttp` reads resolved header values directly from the
  route instead of calling `secretResolver`
- Remove `tenantId` from `InstanceRoute` (was only needed for secret resolution)
- Rename `addInstance`/`removeInstance` → `addRoute`/`removeRoute`

**New types** in `packages/proxy/src/types.ts`:
```ts
interface ResolvedCredentialRule {
  domain: string;
  headers: Record<string, string>; // actual values, no templates
}

interface ResolvedRoute {
  allowlist: string[];
  credentials?: ResolvedCredentialRule[];
}

interface ProxyControl {
  addRoute(sourceIp: string, route: ResolvedRoute): void | Promise<void>;
  removeRoute(sourceIp: string): void | Promise<void>;
}
```

`ForwardProxy` implements `ProxyControl`.

**Files modified:** `apps/api/package.json` (add `@boilerhouse/proxy` dep, remove local proxy imports)

---

### Phase 2: Add control API and remote client

**`packages/proxy/src/control-server.ts`** — HTTP control API using `Bun.serve()`:

| Method | Path              | Body            | Purpose                |
|--------|-------------------|-----------------|------------------------|
| PUT    | /routes/:sourceIp | `ResolvedRoute` | Register/update route  |
| DELETE | /routes/:sourceIp | —               | Deregister route       |
| GET    | /health           | —               | Health check           |

**`packages/proxy/src/remote-client.ts`** — `RemoteProxyClient implements ProxyControl`:
- `addRoute()` → `PUT /routes/:sourceIp`
- `removeRoute()` → `DELETE /routes/:sourceIp`

**`packages/proxy/src/main.ts`** — standalone entrypoint:
- Reads `PROXY_PORT` (default `8080`), `CONTROL_PORT` (default `9090`)
- Starts `ForwardProxy` + `ControlServer`

**Tests:** `control-server.test.ts`, `remote-client.test.ts`

---

### Phase 3: Refactor API to use `ProxyControl`

**`apps/api/src/proxy-registrar.ts`:**
- Constructor takes `ProxyControl` (interface) instead of `ForwardProxy` (concrete)
- Constructor takes `SecretStore` (unchanged)
- `registerInstance()` eagerly resolves `${global-secret:X}` and `${tenant-secret:X}`
  via `SecretStore.resolveSecretRefs()` before sending to proxy
- Golden boot (empty tenantId): skip credential rules containing `${tenant-secret:...}`
  — credentials are properly registered when a real tenant claims the instance
- Methods become async (RemoteProxyClient returns Promises)

**New method — `ProxyRegistrar.refreshTenantRoutes()`:**
- Called when secrets change
- Queries active instances for the tenant from DB
- Gets container IP for each, re-registers with freshly resolved headers

**`apps/api/src/routes/secrets.ts`:**
- After `secretStore.set()`: call `proxyRegistrar.refreshTenantRoutes(tenantId)`
- After `secretStore.delete()`: same refresh

**`apps/api/src/routes/deps.ts`:**
- Add `proxyRegistrar?: ProxyRegistrar` to `RouteDeps`

**`apps/api/src/server.ts`:**
- New env vars: `PROXY_MODE` (`in-process` | `remote`), `PROXY_CONTROL_URL`,
  `PROXY_ADDRESS`
- In-process mode: create `ForwardProxy` as before, use as `ProxyControl`
- Remote mode: create `RemoteProxyClient(PROXY_CONTROL_URL)`
- `proxyAddress` passed to `PodmanRuntime`: use `PROXY_ADDRESS` env var
  (e.g., `http://boilerhouse-proxy:8080`) instead of constructing from
  `host.containers.internal:${port}`

**`apps/api/src/instance-manager.ts`**, **`apps/api/src/snapshot-manager.ts`:**
- Await the now-async `proxyRegistrar` calls (minor change, methods already async)

---

### Phase 4: Add Podman network support

**`packages/runtime-podman/src/client.ts`:**

Add `networks` to `ContainerCreateSpec`:
```ts
networks?: Record<string, { aliases?: string[] }>;
```

Update `buildCreateBody()` to include `networks` when present.

Add methods:
```ts
async ensureNetwork(name: string): Promise<void>   // POST /libpod/networks/create, 409=ok
async networkExists(name: string): Promise<boolean> // GET /libpod/networks/:name/json
```

**`packages/runtime-podman/src/types.ts`:**

Add to `PodmanConfig`:
```ts
/** @example "boilerhouse" */
networkName?: string;
```

**`packages/runtime-podman/src/runtime.ts`:**
- Store `networkName` from config
- In `create()`: when `access !== "none"` and `networkName` is set, add
  `spec.networks = { [this.networkName]: {} }`
- When `networks` is set, don't set `spec.netns` (Podman infers bridge mode)
- Call `client.ensureNetwork(networkName)` lazily on first container create
- In `getContainerIp()`: prefer IP from the configured network for determinism

**`apps/api/src/server.ts`:**
- Add env var `BOILERHOUSE_NETWORK_NAME` (optional)
- Pass to `PodmanRuntime` constructor

**Tests:** Mock HTTP server tests for `ensureNetwork`/`networkExists` in
`packages/runtime-podman/src/client.test.ts`

---

### Phase 5: Dockerfiles

**`deploy/Dockerfile.api`:**
```dockerfile
FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/logger/package.json packages/logger/
COPY packages/proxy/package.json packages/proxy/
COPY packages/runtime-podman/package.json packages/runtime-podman/
COPY apps/api/package.json apps/api/
RUN bun install --frozen-lockfile
COPY packages/ packages/
COPY apps/api/ apps/api/
EXPOSE 3000
CMD ["bun", "apps/api/src/server.ts"]
```

**`deploy/Dockerfile.proxy`:**
```dockerfile
FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/proxy/package.json packages/proxy/
RUN bun install --frozen-lockfile
COPY packages/proxy/ packages/proxy/
EXPOSE 8080 9090
CMD ["bun", "packages/proxy/src/main.ts"]
```

**`deploy/Dockerfile.dashboard`:**
```dockerfile
FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/dashboard/package.json apps/dashboard/
RUN bun install --frozen-lockfile
COPY apps/dashboard/ apps/dashboard/
EXPOSE 3001
CMD ["bun", "apps/dashboard/src/server.ts"]
```

---

### Phase 6: Docker Compose

**`deploy/docker-compose.yml`:**

```yaml
services:
  api:
    build: { context: .., dockerfile: deploy/Dockerfile.api }
    container_name: boilerhouse-api
    environment:
      PORT: "3000"
      DB_PATH: /data/boilerhouse.db
      STORAGE_PATH: /data/storage
      SNAPSHOT_DIR: /data/snapshots
      RUNTIME_TYPE: podman
      PODMAN_SOCKET: /run/podman/podman.sock
      PROXY_MODE: remote
      PROXY_CONTROL_URL: http://boilerhouse-proxy:9090
      PROXY_ADDRESS: http://boilerhouse-proxy:8080
      BOILERHOUSE_SECRET_KEY: ${BOILERHOUSE_SECRET_KEY:-}
      BOILERHOUSE_NETWORK_NAME: boilerhouse
    volumes:
      - boilerhouse-data:/data
      - /run/boilerhouse/podman.sock:/run/podman/podman.sock
    networks: [boilerhouse]
    depends_on: [proxy]
    restart: unless-stopped

  proxy:
    build: { context: .., dockerfile: deploy/Dockerfile.proxy }
    container_name: boilerhouse-proxy
    environment:
      PROXY_PORT: "8080"
      CONTROL_PORT: "9090"
    networks: [boilerhouse]
    restart: unless-stopped

  dashboard:
    build: { context: .., dockerfile: deploy/Dockerfile.dashboard }
    container_name: boilerhouse-dashboard
    environment:
      PORT: "3001"
      API_URL: http://boilerhouse-api:3000
    ports: ["3001:3001"]
    networks: [boilerhouse]
    depends_on: [api]
    restart: unless-stopped

volumes:
  boilerhouse-data:

networks:
  boilerhouse:
    external: true  # created by install script, shared with managed containers
```

The `boilerhouse` network is `external: true` because it must also be used by managed
containers that PodmanRuntime creates dynamically (outside compose).

---

### Phase 7: Deployment scripts and documentation

**Update `scripts/setup-boilerhoused.sh`:**
- Add network creation at the end: `podman network create boilerhouse 2>/dev/null || true`

**Update `deploy/boilerhoused.service`:**
- Add network creation to `ExecStartPost`

**Create `scripts/deploy.sh`** (with `--dry-run`):
1. Verify Podman daemon is running
2. Ensure `boilerhouse` network exists
3. Generate `BOILERHOUSE_SECRET_KEY` if not set
4. Run `podman compose -f deploy/docker-compose.yml up -d --build`

**Create `docs/deployment.md`:**
- Prerequisites (Linux, Podman, CRIU)
- Quick start (setup script → deploy script)
- Architecture diagram
- Environment variable reference
- Volume mounts
- How to update containers
- Accessing the API and dashboard
- Troubleshooting

---

### Phase 8: Tests

TDD — write failing tests first in each phase, then implement.

| Phase | Tests                                                             |
|-------|-------------------------------------------------------------------|
| 1     | Move and update existing proxy tests; update imports              |
| 2     | `control-server.test.ts`, `remote-client.test.ts`                |
| 3     | Update `proxy-registrar.test.ts` for ProxyControl interface;     |
|       | add `refreshTenantRoutes` tests; update secrets route tests      |
| 4     | `ensureNetwork`/`networkExists` unit tests in `client.test.ts`;  |
|       | update runtime tests for `networks` field in create spec         |
| 5-7   | Manual: `podman compose up`, verify containers start, managed    |
|       | containers can reach proxy by name                               |

## Edge Cases

**Golden boot with tenant secrets:** During golden snapshot creation, `tenantId` is empty.
Credential rules containing `${tenant-secret:...}` are skipped. Credentials are properly
registered when a real tenant claims the instance.

**Proxy restart:** If the proxy container restarts, its routing table is empty. The API
re-registers routes during normal instance lifecycle (claim, restore). For v1 this is
acceptable. Future improvement: API detects proxy restart and re-pushes all active routes.

**Secret rotation race:** A secret update and concurrent instance registration could cause
the instance to get stale secrets. The next secret update or manual re-push corrects this.
Acceptable for v1.

## Verification

1. `bun test --recursive` — all unit tests pass
2. `podman compose -f deploy/docker-compose.yml up --build`
3. `curl http://localhost:3001` — dashboard loads
4. Register a workload with network access, claim a tenant, verify the managed container
   can reach external APIs through the proxy (`boilerhouse-proxy:8080`)
5. Update a tenant secret via API, verify the proxy receives updated resolved headers
