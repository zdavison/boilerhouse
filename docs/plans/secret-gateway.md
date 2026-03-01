# Secret Gateway

## Problem

Containers run untrusted code (AI agents) that can execute arbitrary shell commands. If a
container has an API key in its environment (e.g. `ANTHROPIC_API_KEY`), the agent — or a
user instructing the agent — can trivially exfiltrate it:

```bash
echo $ANTHROPIC_API_KEY
cat /proc/self/environ
```

No in-container protection works against this. If the secret is in the process's memory
and the process can execute arbitrary code, the secret is compromised.

The secret must never enter the container.

## Solution: credential-injecting egress proxy

Extend the existing `ForwardProxy` (`apps/api/src/proxy/`) to inject credentials into
outbound HTTP requests based on the container's IP and the destination domain. Containers
are identified by their source IP (per-container networks from the security plan) — no
bearer token or secret enters the container.

```
Container (no secrets)                  ForwardProxy
┌──────────────────┐                   ┌─────────────────────────────┐
│ Agent sends:     │                   │ 1. Source IP → instance     │
│ POST /v1/messages│                   │ 2. Host → credential rule   │
│ Host: api.       │──── HTTP ────────→│ 3. Inject headers           │
│   anthropic.com  │   (no auth hdr)   │ 4. Forward to upstream      │──→ api.anthropic.com
│                  │                   │    (with real API key)       │    (authenticated)
└──────────────────┘                   └─────────────────────────────┘
```

### Container identity

Per-container Podman networks (security plan item 3) give each container a unique IP on
an isolated bridge. The `ForwardProxy` already uses source IP to look up the routing
table. This identity is:

- **Unforgeable** — containers can't spoof source IPs across different bridges.
- **Lifetime-scoped** — the network is created on start/restore and destroyed on
  hibernate/destroy. No token rotation needed.
- **Zero in-container state** — nothing to exfiltrate.

### HTTPS handling

The current `ForwardProxy` supports HTTPS via `CONNECT` tunnels, but a tunnel is an
opaque byte stream — the proxy can't inspect or modify the TLS-encrypted request headers.

For credential injection to work, the container must send plaintext HTTP to the proxy,
and the proxy makes the TLS connection upstream. This is a standard forward proxy pattern:

```
Container → HTTP (plaintext) → ForwardProxy → HTTPS (TLS) → upstream API
```

The container's `HTTP_PROXY` / `HTTPS_PROXY` env vars point at the proxy. Most HTTP
clients (curl, Python requests, Node fetch, SDKs) automatically route through proxies
and send plaintext when configured this way. Some clients need `BASE_URL` overrides
instead — either approach works since the proxy sees plaintext.

For domains that need credential injection, the proxy must **reject** `CONNECT` tunnels
(since it can't inject headers into encrypted streams) and only accept plaintext HTTP.
For domains that don't need credential injection, `CONNECT` tunnels remain available.

---

## Workload TOML schema changes

### Template syntax: `${name}` vs `${secret:name}`

A unified `${...}` template syntax with a `secret:` namespace prefix:

| Syntax              | Resolved by       | When             | Source                  |
|---------------------|-------------------|------------------|------------------------|
| `${VAR}`            | `resolveEnvVars`  | Container create | Host process env        |
| `${secret:NAME}`    | `ForwardProxy`    | Request time     | Tenant secret store (DB)|

### New `network.credentials` section

```toml
[network]
access = "restricted"
allowlist = ["api.anthropic.com", "api.openai.com", "registry.npmjs.org"]

[[network.credentials]]
domain = "api.anthropic.com"
headers = { "x-api-key" = "${secret:ANTHROPIC_API_KEY}" }

[[network.credentials]]
domain = "api.openai.com"
headers = { "Authorization" = "Bearer ${secret:OPENAI_API_KEY}" }
```

- `domain` — the destination domain this rule applies to. Matched using the existing
  `matchesDomain()` logic (supports wildcards like `*.example.com`).
- `headers` — key-value map of headers to inject/overwrite on matching requests.
  Values containing `${secret:NAME}` are resolved from the tenant's secret store.
  Values containing `${VAR}` are resolved at workload load time from host env.
  Literal strings are passed through unchanged.

A credential rule implies the domain is in the allowlist — the parser should
enforce this (error if a credential domain isn't in the allowlist).

### Validation rules

| Context                        | `${VAR}`      | `${secret:NAME}`         |
|--------------------------------|---------------|--------------------------|
| `entrypoint.env`               | Resolved      | **Error** — secrets must not enter the container |
| `network.credentials.headers`  | Resolved      | Stored as-is, resolved at request time |
| All other string fields        | Resolved      | **Error**                |

### Updated `resolveEnvVars`

The existing function resolves all `${...}` references from host env. It needs to:

1. Recognise `${secret:...}` references and **leave them as-is** (not resolve, not
   error) when processing `network.credentials.headers`.
2. **Error** if `${secret:...}` appears in `entrypoint.env` or other fields.

```typescript
// Resolves ${VAR} from host env; leaves ${secret:NAME} untouched.
function resolveTemplates(value: string): string {
  return value.replace(/\$\{((?:secret:)?\w+)\}/g, (match, ref: string) => {
    if (ref.startsWith("secret:")) return match; // leave for gateway
    return process.env[ref] ?? "";
  });
}

// Errors if any ${secret:...} references are present.
function assertNoSecretRefs(env: Record<string, string>, context: string): void {
  for (const [key, value] of Object.entries(env)) {
    if (/\$\{secret:\w+\}/.test(value)) {
      throw new WorkloadParseError(
        `${context}: '${key}' contains a secret reference — ` +
        `secrets cannot be injected into container environment variables`,
      );
    }
  }
}
```

### Example: openclaw.toml after migration

```toml
[workload]
name = "openclaw"
version = "0.1.0"

[image]
ref = "localhost/openclaw:latest"

[resources]
vcpus = 2
memory_mb = 2048
disk_gb = 10

[network]
access = "restricted"
allowlist = [
  "api.anthropic.com",
  "api.openai.com",
  "registry.npmjs.org",
]
expose = [{ guest = 18789, host_range = [30000, 30099] }]

[[network.credentials]]
domain = "api.anthropic.com"
headers = { "x-api-key" = "${secret:ANTHROPIC_API_KEY}" }

[filesystem]
overlay_dirs = ["/home/node/.openclaw"]

[idle]
timeout_seconds = 600
action = "hibernate"

[health]
interval_seconds = 2
unhealthy_threshold = 60

[health.http_get]
path = "/__openclaw/control-ui-config.json"
port = 18789

[entrypoint]
workdir = "/app"
cmd = "node"
args = ["--disable-warning=ExperimentalWarning", "openclaw.mjs", "gateway", "--allow-unconfigured", "--bind", "lan"]

[entrypoint.env]
OPENCLAW_GATEWAY_TOKEN = "73307c8aab2b025f959a53f5095c0addec0be76fe4b5d470"

[metadata]
description = "OpenClaw autonomous AI agent"
homepage = "https://github.com/openclaw/openclaw"
connect_url = "/?token=73307c8aab2b025f959a53f5095c0addec0be76fe4b5d470"
```

Note: `ANTHROPIC_API_KEY` is no longer in `entrypoint.env`. The agent's HTTP requests to
`api.anthropic.com` are intercepted by the proxy, which injects the `x-api-key` header
from the tenant's secret store. The agent needs its `ANTHROPIC_BASE_URL` pointed at the
proxy (or `HTTP_PROXY` set), handled below.

---

## Tenant secret store

### Schema

New `tenant_secrets` table:

| Column         | Type    | Notes                                        |
|----------------|---------|----------------------------------------------|
| `tenant_id`    | TEXT    | FK → tenants.tenant_id                       |
| `name`         | TEXT    | Secret name (e.g. `ANTHROPIC_API_KEY`)       |
| `value`        | TEXT    | Encrypted secret value                       |
| `created_at`   | INTEGER | Epoch ms                                     |
| `updated_at`   | INTEGER | Epoch ms                                     |
| PK             |         | (`tenant_id`, `name`)                        |

Values are encrypted at rest using AES-256-GCM with a server-side key
(`BOILERHOUSE_SECRET_KEY` env var). The key never leaves the API server process.

### Admin API

```
PUT  /api/v1/tenants/:id/secrets/:name   { "value": "sk-ant-..." }
GET  /api/v1/tenants/:id/secrets          → [{ "name": "ANTHROPIC_API_KEY", "created_at": ... }]
                                            (values are never returned)
DELETE /api/v1/tenants/:id/secrets/:name
```

These endpoints require admin-scoped API keys (from the auth plan).

---

## ForwardProxy changes

### Extended routing table

The current routing table maps `sourceIp → string[]` (allowlist). Extend to:

```typescript
interface InstanceRoute {
  allowlist: string[];
  credentials: CredentialRule[];
}

interface CredentialRule {
  domain: string;
  /** Header values with unresolved ${secret:NAME} references. */
  headers: Record<string, string>;
}

// Map<sourceIp, InstanceRoute>
```

### Registration lifecycle

| Event                 | Action                                              |
|-----------------------|-----------------------------------------------------|
| Container start       | Resolve container IP, call `proxy.addInstance(ip, route)` |
| Container restore     | New IP on new network, call `proxy.addInstance(ip, route)` |
| Container hibernate   | Call `proxy.removeInstance(ip)`, destroy network     |
| Container destroy     | Call `proxy.removeInstance(ip)`, destroy network     |

### Request handling changes

In `handleHttp()`, after domain allowlist check:

1. Find matching `CredentialRule` for the destination domain.
2. If found, resolve `${secret:NAME}` references by looking up the tenant's secrets.
   The proxy needs a reference to the secret store (or a callback) to resolve these.
3. Inject/overwrite the declared headers into the outbound request.
4. Forward to upstream over TLS.

In `handleConnect()`:

1. If the destination domain has a `CredentialRule`, **reject** the `CONNECT` tunnel
   with `403 Forbidden: use plaintext HTTP for credentialed domains`. The proxy cannot
   inject headers into encrypted tunnels.
2. If no credential rule, allow the tunnel as before.

### Secret resolution at request time

The proxy resolves `${secret:NAME}` on every request, not cached:

```typescript
function resolveSecretHeaders(
  headers: Record<string, string>,
  tenantSecrets: Map<string, string>,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    resolved[key] = value.replace(
      /\$\{secret:(\w+)\}/g,
      (_, name: string) => {
        const secret = tenantSecrets.get(name);
        if (!secret) throw new Error(`Secret '${name}' not found`);
        return secret;
      },
    );
  }
  return resolved;
}
```

Resolving per-request (not cached) means secret rotation takes effect immediately.

---

## Container configuration

Containers need to route HTTP traffic through the proxy. Two options:

### Option A: `HTTP_PROXY` env vars (preferred)

Set `HTTP_PROXY` and `HTTPS_PROXY` in the container's environment at create time,
pointing at the proxy's address on the container's bridge gateway:

```typescript
// In PodmanRuntime.create(), after network setup:
spec.env = {
  ...spec.env,
  HTTP_PROXY: `http://${gatewayIp}:${proxyPort}`,
  HTTPS_PROXY: `http://${gatewayIp}:${proxyPort}`,
  NO_PROXY: "localhost,127.0.0.1",
};
```

Most HTTP clients respect these env vars automatically. The container sends plaintext
HTTP to the proxy; the proxy makes TLS connections upstream.

### Option B: `BASE_URL` overrides

For clients that don't respect proxy env vars, the workload can set a base URL:

```toml
[entrypoint.env]
ANTHROPIC_BASE_URL = "http://${GATEWAY_HOST}:${GATEWAY_PORT}"
```

These are resolved at create time from host env via the existing `resolveEnvVars`.

Option A is preferred because it's transparent — no workload-specific configuration
needed. Option B is a fallback for stubborn clients.

---

## Code changes

| File                                            | Change                                         |
|-------------------------------------------------|------------------------------------------------|
| `packages/core/src/workload.ts`                 | Add `CredentialRuleSchema` to `NetworkSchema`  |
| `packages/core/src/workload.ts`                 | Add `assertNoSecretRefs` validation            |
| `packages/runtime-podman/src/runtime.ts`        | Update `resolveEnvVars` → `resolveTemplates`   |
| `packages/runtime-podman/src/runtime.ts`        | Inject `HTTP_PROXY` env vars on create/restore |
| `packages/db/src/schema.ts`                     | Add `tenant_secrets` table                     |
| `packages/db/drizzle/`                          | New migration                                  |
| `apps/api/src/secret-store.ts`                  | New — encrypt/decrypt, CRUD for tenant secrets |
| `apps/api/src/routes/tenants.ts`                | Add secret management endpoints                |
| `apps/api/src/proxy/proxy.ts`                   | Extend routing table, inject headers           |
| `apps/api/src/proxy/proxy.ts`                   | Reject CONNECT for credentialed domains        |
| `apps/api/src/instance-manager.ts`              | Register/deregister proxy routes on lifecycle  |
| `apps/api/src/server.ts`                        | Instantiate proxy, pass to deps                |
| `apps/api/src/routes/deps.ts`                   | Add `secretStore` + `proxy` to `RouteDeps`     |
| `workloads/openclaw.toml`                       | Remove `ANTHROPIC_API_KEY` from env, add credential rule |

---

## Dependencies

This plan depends on:

- **`podman-security.md` item 3** (per-container networks) — required for IP-based
  identity. Without isolated networks, containers could spoof source IPs.
- **`podman-security.md` item 1** (API authentication) — required for the secret
  management admin API.

This plan is independent of `podman-hardening.md` (those items harden the host-side
privilege boundary; this plan is application-layer).

---

## Implementation order

| Step | Description                          | Effort |
|------|--------------------------------------|--------|
| 1    | Template syntax (`resolveTemplates`, `assertNoSecretRefs`) | Small  |
| 2    | Workload schema (`network.credentials`)                    | Small  |
| 3    | Tenant secret store (table, encryption, CRUD API)          | Medium |
| 4    | ForwardProxy credential injection (header rewriting)       | Medium |
| 5    | Proxy lifecycle wiring (register/deregister on start/stop) | Medium |
| 6    | `HTTP_PROXY` injection in PodmanRuntime                    | Small  |
| 7    | Migrate `openclaw.toml`                                    | Small  |
