# Envoy Sidecar Proxy — Unified Network Isolation

Replaces the shared `ForwardProxy` in the API server with per-instance Envoy
sidecar containers. Applies to both Podman and Kubernetes runtimes.

## Context

The current network isolation architecture uses a **centralised shared proxy**
running inside the API server process (`apps/api/src/proxy/`). Containers point
`HTTP_PROXY` at the host, the proxy routes by source IP, and injects credential
headers at request time.

Problems:

1. **Single point of failure** — one proxy serves all tenants.
2. **Credential isolation** — the proxy's `secretResolver` has access to every
   tenant's secrets, even though each request only uses one tenant's.
3. **Architecture divergence** — Podman uses the shared proxy; Kubernetes has no
   proxy at all yet.
4. **Source-IP coupling** — requires `getContainerIp()`, routing table bookkeeping,
   and `ProxyRegistrar` lifecycle hooks.

## Design: Per-Instance Envoy Sidecar

Each workload instance with `network.access === "restricted"` gets its own Envoy
proxy container running alongside it. The two containers share a network namespace
(via podman pod or k8s pod), so the workload talks to Envoy on `localhost:18080`.

```
┌─────────────────────────────────────────┐
│ Pod / Podman Pod                        │
│                                         │
│  ┌──────────────┐  ┌────────────────┐   │
│  │ workload     │  │ envoy          │   │
│  │              │──│                │   │
│  │ HTTP_PROXY=  │  │ :18080         │   │
│  │ localhost:   │  │                │   │
│  │ 18080        │  │ config from    │   │
│  │              │  │ mounted file   │   │
│  └──────────────┘  └────────────────┘   │
│         shared network namespace        │
└─────────────────────────────────────────┘
         │
         ▼ TLS to upstream (api.anthropic.com:443, etc.)
```

### Why Envoy

- Battle-tested forward proxy with HTTP/1.1 absolute-URL support
  (`allow_absolute_url: true`).
- Native per-route header injection (`request_headers_to_add`).
- TLS origination (accept HTTP from client, connect TLS to upstream).
- Domain-based virtual host routing with wildcard support.
- Static bootstrap config — no control plane needed.
- Extensive security audit history and CVE process.
- Rich observability (access logs, Prometheus metrics) for free.

### Why sidecar, not shared service

| Aspect              | Shared service (current)                | Sidecar (proposed)                    |
|---------------------|-----------------------------------------|---------------------------------------|
| Credential isolation| All tenants' secrets in one process     | Each proxy only sees its own tenant   |
| Blast radius        | Proxy crash affects all agents          | Only affects one agent                |
| Scaling             | Single bottleneck                       | Scales with instances                 |
| Cross-tenant risk   | Source-IP routing table correctness     | Impossible by construction            |
| API server coupling | ForwardProxy, ProxyRegistrar, lifecycle hooks | None                           |
| Runtime parity      | Podman only                             | Identical for Podman and Kubernetes   |

## Envoy Config Generation

### New package: `packages/envoy-sidecar/`

```
packages/envoy-sidecar/
  package.json
  src/
    config.ts          generateEnvoyConfig(opts) → JSON string
    config.test.ts     Unit tests for config generation
    types.ts           SidecarProxyConfig interface
```

### Input: `SidecarProxyConfig`

```typescript
interface SidecarProxyConfig {
  /** Domains the workload is allowed to reach. Supports wildcards (*.example.com). */
  allowlist: string[];
  /** Pre-resolved credential rules. Secret templates already replaced with actual values. */
  credentials: Array<{
    domain: string;
    headers: Record<string, string>;
  }>;
  /** Envoy listener port. Default 18080. */
  port?: number;
}
```

Secrets are resolved **before** config generation. The config contains actual
credential values, not `${tenant-secret:...}` templates.

### Output: Envoy bootstrap config (JSON)

For a workload with:
```json
{
  "allowlist": ["api.anthropic.com", "api.openai.com", "example.com"],
  "credentials": [
    { "domain": "api.anthropic.com", "headers": { "x-api-key": "sk-ant-actual" } },
    { "domain": "api.openai.com", "headers": { "Authorization": "Bearer sk-actual" } }
  ]
}
```

The generator produces:

```yaml
admin:
  address:
    socket_address: { address: 127.0.0.1, port_value: 18081 }

static_resources:
  listeners:
  - name: proxy
    address:
      socket_address: { address: 127.0.0.1, port_value: 18080 }
    filter_chains:
    - filters:
      - name: envoy.filters.network.http_connection_manager
        typed_config:
          "@type": type.googleapis.com/envoy.extensions.filters.network.http_connection_manager.v3.HttpConnectionManager
          stat_prefix: egress_proxy
          http_protocol_options:
            allow_absolute_url: true    # Forward proxy mode
          route_config:
            name: local_route
            virtual_hosts:
            # Credentialed domain — header injection + TLS origination
            - name: api_anthropic_com
              domains: ["api.anthropic.com"]
              routes:
              - match: { prefix: "/" }
                route: { cluster: upstream_api_anthropic_com }
                request_headers_to_add:
                - header: { key: "x-api-key", value: "sk-ant-actual" }
                  append_action: OVERWRITE_IF_EXISTS_OR_ADD
            # Another credentialed domain
            - name: api_openai_com
              domains: ["api.openai.com"]
              routes:
              - match: { prefix: "/" }
                route: { cluster: upstream_api_openai_com }
                request_headers_to_add:
                - header: { key: "Authorization", value: "Bearer sk-actual" }
                  append_action: OVERWRITE_IF_EXISTS_OR_ADD
            # Non-credentialed allowed domain
            - name: example_com
              domains: ["example.com"]
              routes:
              - match: { prefix: "/" }
                route: { cluster: upstream_example_com }
            # Catch-all: deny everything else
            - name: deny_all
              domains: ["*"]
              routes:
              - match: { prefix: "/" }
                direct_response:
                  status: 403
                  body: { inline_string: "Forbidden: domain not in allowlist" }

  clusters:
  - name: upstream_api_anthropic_com
    type: STRICT_DNS
    transport_socket:
      name: envoy.transport_sockets.tls
      typed_config:
        "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.UpstreamTlsContext
        sni: api.anthropic.com
    load_assignment:
      cluster_name: upstream_api_anthropic_com
      endpoints:
      - lb_endpoints:
        - endpoint:
            address:
              socket_address: { address: api.anthropic.com, port_value: 443 }
  - name: upstream_api_openai_com
    # ... same pattern, TLS origination
  - name: upstream_example_com
    type: STRICT_DNS
    transport_socket:
      name: envoy.transport_sockets.tls
      typed_config:
        "@type": type.googleapis.com/envoy.extensions.transport_sockets.tls.v3.UpstreamTlsContext
        sni: example.com
    load_assignment:
      cluster_name: upstream_example_com
      endpoints:
      - lb_endpoints:
        - endpoint:
            address:
              socket_address: { address: example.com, port_value: 443 }
```

### Wildcard domains

For `*.example.com` in the allowlist, Envoy virtual hosts support wildcard
domain matching natively. We generate a single cluster with a dynamic forward
proxy filter for wildcard entries, since we can't pre-configure a cluster per
subdomain.

Alternatively: for wildcard non-credentialed domains, use Envoy's
[dynamic forward proxy](https://www.envoyproxy.io/docs/envoy/latest/configuration/http/http_filters/dynamic_forward_proxy_filter)
filter, which resolves DNS dynamically. The virtual host allowlists the domain
pattern; the dynamic forward proxy handles upstream resolution.

### HTTPS / CONNECT handling

The current proxy rejects CONNECT for credentialed domains (can't inject headers
into an encrypted tunnel) and tunnels CONNECT for non-credentialed domains.

With Envoy sidecars, we set both `HTTP_PROXY` and `HTTPS_PROXY` to
`http://localhost:18080`. Envoy handles:

- **HTTP requests** (absolute URL): route by Host, inject headers, TLS
  origination to upstream. This covers credentialed domains.
- **CONNECT requests** (HTTPS): for non-credentialed allowed domains, Envoy
  terminates CONNECT and tunnels to upstream. For credentialed domains, Envoy
  returns 403 (same as current behaviour — forces client to use HTTP mode).
  Clients that respect `HTTP_PROXY` for `http://` URLs and `HTTPS_PROXY` for
  `https://` URLs will use forward proxy mode for both.

The key insight: since credentials are injected via `HTTP_PROXY` (not tunnelled),
clients calling credentialed APIs should use `http://` URLs. The proxy upgrades
to TLS on the upstream side. This matches the current architecture.

## Runtime Interface Changes

### New: `CreateOptions.proxyConfig`

```typescript
// packages/core/src/runtime.ts

interface CreateOptions {
  /** Serialised Envoy bootstrap config JSON. When provided, the runtime
   *  creates an Envoy sidecar alongside the workload container. */
  proxyConfig?: string;
  onLog?: (line: string) => void;
}

interface Runtime {
  create(workload: Workload, instanceId: InstanceId, options?: CreateOptions): Promise<InstanceHandle>;
  // ... rest unchanged
}
```

The `proxyConfig` is an opaque string (Envoy JSON config) generated by
`packages/envoy-sidecar/`. Each runtime knows how to mount it.

### Removed

- `getContainerIp?()` — no longer needed (no source-IP routing).
- `proxyAddress` from `PodmanConfig` — no longer needed (proxy is in-pod).

## Phase 1: Podman Runtime (sidecar via podman pods)

### 1a. Envoy config generator

Create `packages/envoy-sidecar/` with `generateEnvoyConfig()`.

- Input: `SidecarProxyConfig` (allowlist + resolved credentials)
- Output: Envoy bootstrap config as JSON string
- Unit tests: verify generated config structure, wildcard handling, credential
  injection, catch-all deny, cluster TLS origination

### 1b. Podman pod support

Podman pods share a network namespace across containers, identical to k8s pods.

**Container lifecycle changes in `PodmanRuntime`:**

Currently:
```
create container → start container → (snapshot → restore) → destroy container
```

Proposed:
```
create pod → create envoy container in pod → create workload container in pod →
start pod → (snapshot workload container → restore into new pod) →
destroy pod
```

**DaemonBackend additions (`packages/runtime-podman/`):**

New Podman API calls:
- `POST /v5.0.0/libpod/pods/create` — create pod with port mappings
- `POST /v5.0.0/libpod/pods/{name}/start` — start all containers in pod
- `POST /v5.0.0/libpod/pods/{name}/stop` — stop all containers
- `DELETE /v5.0.0/libpod/pods/{name}` — remove pod and all containers

**PodmanRuntime.create() changes:**

```typescript
async create(workload, instanceId, options?) {
  const podName = instanceId;

  // 1. Create podman pod with port mappings
  await this.backend.createPod(podName, {
    portmappings: workload.network.expose?.map(...) ?? defaultPorts,
    netns: workload.network.access === "none" ? { nsmode: "none" } : undefined,
  });

  // 2. If proxy config provided, create Envoy sidecar in the pod
  if (options?.proxyConfig) {
    const configPath = join(this.configDir, `${instanceId}-envoy.json`);
    await writeFile(configPath, options.proxyConfig);

    await this.backend.createContainer({
      name: `${instanceId}-proxy`,
      pod: podName,
      image: "envoyproxy/envoy:v1.32-latest",
      command: ["envoy", "-c", "/etc/envoy/envoy.json", "--log-level", "warn"],
      mounts: [{ source: configPath, destination: "/etc/envoy/envoy.json", type: "bind" }],
    });
  }

  // 3. Create workload container in the pod
  const spec = buildContainerSpec(workload, instanceId);
  spec.pod = podName;
  if (options?.proxyConfig) {
    spec.env ??= {};
    spec.env.HTTP_PROXY = "http://localhost:18080";
    spec.env.http_proxy = "http://localhost:18080";
    // No host.containers.internal needed — proxy is on localhost
  }

  await this.backend.createContainer(spec);
  return { instanceId };
}
```

**PodmanRuntime.destroy() changes:**

```typescript
async destroy(handle) {
  // Delete pod removes all containers
  await this.backend.deletePod(handle.instanceId);
  // Clean up config file
  await unlink(join(this.configDir, `${handle.instanceId}-envoy.json`)).catch(() => {});
}
```

### 1c. CRIU checkpoint/restore with pods

CRIU checkpoints a single container process tree. In a podman pod, each container
runs independently — the infra container owns the shared network namespace.

**Checkpoint flow:**
1. Wait for TCP drain on the workload container (same as today)
2. Checkpoint the **workload container only** (not the Envoy sidecar or infra)
3. Save checkpoint archive (same format as today)

**Restore flow:**
1. Create a new pod (new infra container, new network namespace)
2. Create a fresh Envoy sidecar container in the pod (with the original config)
3. Restore the workload container into the pod from the checkpoint archive
4. Start the pod

The Envoy sidecar is stateless — it just needs the config file. No need to
checkpoint/restore it. The key question is whether CRIU can restore a container
into a different network namespace (the new pod's namespace) than the one it was
checkpointed in.

**Risk:** CRIU restores network namespace state. If the checkpointed container
was joined to a pod network namespace, restoring into a *different* pod's
namespace may fail. This needs testing.

**Mitigation:** If CRIU + pods doesn't work, use a shared podman network instead
of a pod:
- Create a per-instance network (`podman network create inst-{id}`)
- Attach both Envoy and workload containers to it
- Workload uses `HTTP_PROXY=http://proxy:18080` (Envoy container hostname)
- CRIU checkpoints the workload container normally (it owns its own netns)
- On restore, create new network + new Envoy container, restore workload container

This fallback trades the simplicity of pods for CRIU compatibility.

### 1d. Remove shared proxy

After podman sidecar is working:

**Delete:**
- `apps/api/src/proxy/proxy.ts` — ForwardProxy class
- `apps/api/src/proxy/proxy.test.ts`
- `apps/api/src/proxy/sni.ts` — unused SNI parser
- `apps/api/src/proxy-registrar.ts`
- `apps/api/src/proxy-registrar.test.ts`

**Keep:**
- `apps/api/src/proxy/matcher.ts` — `matchesDomain()` is useful for validating
  allowlist entries at workload parse time.
- `apps/api/src/secret-store.ts` — still needed for resolving secrets at
  instance creation time.

**Modify:**

`apps/api/src/instance-manager.ts`:
- Remove `proxyRegistrar` field and constructor parameter
- Remove `registerProxy()` / `deregisterProxy()` methods
- In `create()`: resolve credentials, generate Envoy config, pass to
  `runtime.create(workload, instanceId, { proxyConfig })`
- In `restoreFromSnapshot()`: same — generate config, pass to `runtime.restore()`

`apps/api/src/server.ts`:
- Remove ForwardProxy instantiation
- Remove ProxyRegistrar instantiation
- Remove `proxyAddress` from PodmanRuntime config
- Add credential resolution + config generation before `runtime.create()`

`packages/runtime-podman/src/types.ts`:
- Remove `proxyAddress` from `PodmanConfig`
- Add `configDir` (directory for writing Envoy config files)

`packages/core/src/runtime.ts`:
- Add `CreateOptions` with `proxyConfig?: string`
- Update `create()` and `restore()` signatures
- Remove optional `getContainerIp?()`

## Phase 2: Kubernetes Runtime

### 2a. Envoy sidecar in pod spec

`packages/runtime-kubernetes/src/translator.ts`:

When `proxyConfig` is provided, `workloadToPod()` adds:

1. **Sidecar container** to the pod spec:
   ```typescript
   {
     name: "proxy",
     image: "envoyproxy/envoy:v1.32-latest",
     command: ["envoy", "-c", "/etc/envoy/envoy.json", "--log-level", "warn"],
     ports: [{ containerPort: 18080 }],
     volumeMounts: [{ name: "proxy-config", mountPath: "/etc/envoy" }],
     resources: { limits: { cpu: "100m", memory: "64Mi" } },
   }
   ```

2. **HTTP_PROXY env vars** on the main container:
   ```typescript
   { name: "HTTP_PROXY", value: "http://localhost:18080" },
   { name: "http_proxy", value: "http://localhost:18080" },
   ```

3. **Volume** for the proxy config:
   ```typescript
   { name: "proxy-config", configMap: { name: `${instanceId}-proxy` } }
   ```

### 2b. ConfigMap for proxy config

`KubernetesRuntime.create()`:

```typescript
if (options?.proxyConfig) {
  await this.client.createConfigMap(this.namespace, {
    metadata: { name: `${instanceId}-proxy`, namespace: this.namespace },
    data: { "envoy.json": options.proxyConfig },
  });
}
```

Using a ConfigMap rather than a Secret because the Envoy config is not
k8s-secret-level sensitive (it runs in the same pod as the workload). The
credentials in the config are protected by pod isolation, not by k8s RBAC on
the ConfigMap.

`KubernetesRuntime.destroy()`:

```typescript
await this.client.deleteConfigMap(this.namespace, `${instanceId}-proxy`);
```

### 2c. KubeClient additions

- `createConfigMap(namespace, configMap)` — POST ConfigMap
- `deleteConfigMap(namespace, name)` — DELETE ConfigMap (ignore 404)

### 2d. NetworkPolicy (defense-in-depth)

Same as the original k8s plan — restrict pod egress to DNS only, preventing
the workload container from bypassing the Envoy proxy via direct IP connections.

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: {instanceId}-restrict
spec:
  podSelector:
    matchLabels:
      boilerhouse.dev/instance-id: {instanceId}
  policyTypes: [Egress]
  egress:
  - ports:
    - { protocol: UDP, port: 53 }
    - { protocol: TCP, port: 53 }
    to:
    - namespaceSelector: {}
```

Note: localhost (pod-internal) traffic is not affected by NetworkPolicy.
The Envoy sidecar's egress to upstream APIs is allowed because NetworkPolicy
applies to the pod, and Envoy's outbound connections originate from the pod.

Wait — this blocks Envoy's outbound too. We need to allow egress on 443 from
the pod. Options:

1. Allow all TCP 443 egress (simple, but allows direct connections on 443)
2. No NetworkPolicy — rely on Envoy as the sole enforcement
3. Use Cilium L7 policies (requires Cilium CNI)

For now: option 1 is pragmatic. The NetworkPolicy prevents non-443 bypass
(e.g., raw TCP exfiltration), and Envoy prevents 443 connections to unlisted
domains. Defense in depth, not perfect isolation.

```yaml
egress:
- ports:
  - { protocol: UDP, port: 53 }
  - { protocol: TCP, port: 53 }
  to:
  - namespaceSelector: {}
- ports:
  - { protocol: TCP, port: 443 }
```

### 2e. Envoy image in minikube

For local development with minikube, the `envoyproxy/envoy` image needs to be
available. Either:
- `minikube image pull envoyproxy/envoy:v1.32-latest` in the minikube setup kadai action
- Or use minikube's image cache

## Secret Lifecycle

With the shared proxy, secrets are resolved **at request time** — the proxy
calls `secretStore.resolveSecretRefs()` on every HTTP request. This means
rotated secrets take effect immediately.

With Envoy sidecars, secrets are resolved **at instance creation time** and
baked into the Envoy config. Rotated secrets don't take effect until the
instance is recreated.

**This is acceptable because:**
1. Instance lifecycles are short (hibernation/restore cycles)
2. Secret rotation is infrequent
3. If immediate rotation is needed, destroy + recreate the instance
4. Future enhancement: Envoy's SDS (Secret Discovery Service) could pull
   credentials dynamically, but this adds significant complexity

## Envoy Container Image

Use the official `envoyproxy/envoy:v1.32-latest` (or distroless variant
`envoyproxy/envoy:distroless-v1.32-latest` for production).

No custom image needed — the Envoy config is mounted as a file. This is a
significant advantage: no image build pipeline for the proxy.

## Implementation Order

### Phase 1: Podman

1. **`packages/envoy-sidecar/`** — config generator + tests
2. **`packages/runtime-podman/`** — pod support in DaemonBackend
3. **`packages/runtime-podman/`** — refactor `create()`/`destroy()` to use pods + sidecar
4. **CRIU investigation** — test checkpoint/restore with podman pods; implement
   fallback to shared networks if needed
5. **`packages/core/`** — add `CreateOptions.proxyConfig` to Runtime interface
6. **`apps/api/`** — credential resolution + config generation in InstanceManager
7. **`apps/api/`** — remove ForwardProxy, ProxyRegistrar, source-IP routing
8. **Integration tests** — restricted workload through Envoy sidecar on Podman

### Phase 2: Kubernetes

9. **`packages/runtime-kubernetes/`** — ConfigMap CRUD in KubeClient
10. **`packages/runtime-kubernetes/`** — sidecar injection in translator
11. **`packages/runtime-kubernetes/`** — ConfigMap lifecycle in runtime
12. **`packages/runtime-kubernetes/`** — NetworkPolicy support
13. **Integration tests** — restricted workload through Envoy sidecar on minikube
14. **E2E tests** — verify both runtimes handle restricted workloads identically

## Files to Add

| File | Purpose |
|------|---------|
| `packages/envoy-sidecar/package.json` | Package scaffolding |
| `packages/envoy-sidecar/src/config.ts` | `generateEnvoyConfig()` |
| `packages/envoy-sidecar/src/config.test.ts` | Config generation tests |
| `packages/envoy-sidecar/src/types.ts` | `SidecarProxyConfig` interface |
| `packages/envoy-sidecar/tsconfig.json` | TypeScript config |

## Files to Modify

| File | Change |
|------|--------|
| `packages/core/src/runtime.ts` | Add `CreateOptions`, update `create()`/`restore()` signatures |
| `packages/runtime-podman/src/runtime.ts` | Pod-based creation, sidecar injection, remove `proxyAddress` |
| `packages/runtime-podman/src/types.ts` | Replace `proxyAddress` with `configDir` |
| `packages/runtime-kubernetes/src/translator.ts` | Sidecar container + env injection |
| `packages/runtime-kubernetes/src/runtime.ts` | ConfigMap lifecycle |
| `packages/runtime-kubernetes/src/client.ts` | ConfigMap CRUD |
| `packages/runtime-kubernetes/src/types.ts` | ConfigMap type definitions |
| `apps/api/src/instance-manager.ts` | Credential resolution, config generation, remove proxy hooks |
| `apps/api/src/server.ts` | Remove ForwardProxy/ProxyRegistrar setup |

## Files to Delete

| File | Reason |
|------|--------|
| `apps/api/src/proxy/proxy.ts` | Replaced by Envoy |
| `apps/api/src/proxy/proxy.test.ts` | Tests for removed code |
| `apps/api/src/proxy/sni.ts` | Unused (Envoy handles TLS) |
| `apps/api/src/proxy-registrar.ts` | No longer needed |
| `apps/api/src/proxy-registrar.test.ts` | Tests for removed code |
| `docs/plans/k8s-network-restriction.md` | Superseded by this plan |

## Supersedes

This plan supersedes `docs/plans/k8s-network-restriction.md`, which proposed a
custom Bun-based sidecar proxy. The Envoy approach eliminates custom proxy code
entirely and uses a battle-tested off-the-shelf solution.
