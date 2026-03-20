# Envoy Sidecar Proxy — Unified Network Isolation

Replaces the shared `ForwardProxy` in the API server with per-instance Envoy
sidecar containers. Applies to both Podman and Kubernetes runtimes.

## Status

**Phase 1 (Podman): COMPLETE** — all E2E tests passing.
**Phase 2 (Kubernetes): COMPLETE**

### What was implemented (Phase 1)

- `packages/envoy-config/` — Handlebars-based Envoy config generator
  (`envoy-bootstrap.yaml.hbs` template, `generateEnvoyConfig()`)
- `packages/core/src/runtime.ts` — `CreateOptions` with `proxyConfig` and
  `onLog`; removed `getContainerIp()`
- `packages/runtime-podman/` — always uses podman pods (single code path);
  optional Envoy sidecar when `proxyConfig` provided; pod-based port
  resolution via infra container inspect; CRIU checkpoint/restore across pods
  verified working
- `apps/boilerhouse-podmand/` — pod CRUD endpoints, file write/remove
  endpoints, pod inspect (infra container ID), bind-mount validation scoped
  to config directory
- `apps/api/src/instance-manager.ts` — resolves credentials at creation time
  via `SecretStore`, generates Envoy config, passes `proxyConfig` to runtime
- `apps/api/src/snapshot-manager.ts` — builds sidecar config for golden boot
- `apps/api/src/server.ts` — removed ForwardProxy/ProxyRegistrar setup

### What was deleted

- `apps/api/src/proxy/proxy.ts` — shared ForwardProxy
- `apps/api/src/proxy/proxy.test.ts`
- `apps/api/src/proxy/sni.ts` — SNI parser
- `apps/api/src/proxy/sni.test.ts`
- `apps/api/src/proxy-registrar.ts`
- `apps/api/src/proxy-registrar.test.ts`

### What was kept

- `apps/api/src/proxy/matcher.ts` — domain matching for allowlist validation
- `apps/api/src/secret-store.ts` — resolves secrets at instance creation time

### Key design decisions made during implementation

- **Always use podman pods** — even without a sidecar, the workload container
  runs inside a pod. One code path, no branching.
- **Envoy config as YAML** — Handlebars template in `.yaml.hbs` file for
  syntax highlighting. Output is YAML (Envoy supports it natively).
- **Package renamed** `envoy-sidecar` → `envoy-config` — the package generates
  config, it doesn't contain the sidecar itself.
- **Port mappings on the pod** — in podman pods, port mappings belong to the
  infra container. `resolveHostPorts()` inspects the pod's infra container.
  `snapshot()` captures exposed container ports from the infra container
  (the checkpoint archive doesn't contain them).
- **Bind mount validation** — daemon allows bind mounts only from its managed
  config directory (`proxy-configs/`), not arbitrary paths.

---

## Context

The previous architecture used a **centralised shared proxy** running inside
the API server process. Containers pointed `HTTP_PROXY` at the host, the proxy
routed by source IP, and injected credential headers at request time.

Problems solved:

1. **Single point of failure** — one proxy served all tenants.
2. **Credential isolation** — the proxy's `secretResolver` had access to every
   tenant's secrets.
3. **Architecture divergence** — Podman used the shared proxy; Kubernetes had
   no proxy at all.
4. **Source-IP coupling** — required `getContainerIp()`, routing table
   bookkeeping, and `ProxyRegistrar` lifecycle hooks.

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

## Envoy Config Generation

### Package: `packages/envoy-config/`

```
packages/envoy-config/
  package.json
  src/
    envoy-bootstrap.yaml.hbs   Handlebars template (YAML, syntax-highlighted in VSCode)
    config.ts                  generateEnvoyConfig(opts) → YAML string
    config.test.ts             Unit tests for config generation
    types.ts                   SidecarProxyConfig, CredentialRule
    index.ts                   Public exports
```

### Input: `SidecarProxyConfig`

```typescript
interface SidecarProxyConfig {
  allowlist: string[];
  credentials?: Array<{
    domain: string;
    headers: Record<string, string>;  // pre-resolved, no templates
  }>;
  port?: number;  // default 18080
}
```

Secrets are resolved **before** config generation. The config contains actual
credential values, not `${tenant-secret:...}` templates.

### Secret Lifecycle

Secrets are resolved **at instance creation time** and baked into the Envoy
config. Rotated secrets don't take effect until the instance is recreated.

This is acceptable because:
1. Instance lifecycles are short (hibernation/restore cycles)
2. Secret rotation is infrequent
3. If immediate rotation is needed, destroy + recreate the instance

## Runtime Interface

```typescript
interface CreateOptions {
  proxyConfig?: string;   // Envoy YAML config
  onLog?: (line: string) => void;
}

interface Runtime {
  create(workload, instanceId, options?): Promise<InstanceHandle>;
  restore(ref, instanceId, options?): Promise<InstanceHandle>;
  // ...
}
```

## Phase 2: Kubernetes Runtime — TODO

### 2a. Envoy sidecar in pod spec

`packages/runtime-kubernetes/src/translator.ts`:

When `proxyConfig` is provided, `workloadToPod()` adds:

1. **Sidecar container** to the pod spec:
   ```typescript
   {
     name: "proxy",
     image: "envoyproxy/envoy:v1.32-latest",
     command: ["envoy", "-c", "/etc/envoy/envoy.yaml", "--log-level", "warn"],
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
    data: { "envoy.yaml": options.proxyConfig },
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

Restrict pod egress to DNS + HTTPS only, preventing the workload container
from bypassing the Envoy proxy via direct non-443 connections.

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
  - ports:
    - { protocol: TCP, port: 443 }
```

Localhost (pod-internal) traffic is not affected by NetworkPolicy. The
NetworkPolicy prevents non-443 bypass (e.g., raw TCP exfiltration), and Envoy
prevents 443 connections to unlisted domains. Defense in depth.

**CNI dependency:** NetworkPolicy enforcement requires a CNI that supports it
(Calico, Cilium). Minikube's default (kindnet) does NOT enforce
NetworkPolicies. For local dev, the sidecar proxy alone provides the filtering.

### 2e. Envoy image in minikube

For local development, pull the Envoy image into minikube:
- `minikube image pull envoyproxy/envoy:v1.32-latest` in the minikube setup
  kadai action

### Implementation order

1. ConfigMap CRUD in KubeClient
2. Sidecar injection in translator (accept `proxyConfig` parameter)
3. ConfigMap lifecycle in runtime create/destroy
4. NetworkPolicy support (types, client methods, translator)
5. Integration tests — restricted workload through Envoy sidecar on minikube
6. E2E tests — verify both runtimes handle restricted workloads identically

## Envoy Container Image

Use the official `envoyproxy/envoy:v1.32-latest` (or distroless variant for
production). No custom image needed — the Envoy config is mounted as a file.

## Supersedes

This plan supersedes `docs/plans/k8s-network-restriction.md`, which proposed a
custom Bun-based sidecar proxy. The Envoy approach eliminates custom proxy code
entirely and uses a battle-tested off-the-shelf solution.
