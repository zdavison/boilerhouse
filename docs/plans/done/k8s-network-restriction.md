# K8s Network Restriction: Sidecar Proxy + NetworkPolicy

## Context

Workloads with `network.access: "restricted"` + `allowlist` need outbound traffic
limited to specific domains, and `credentials` rules need HTTP headers injected on
matching requests. On Podman, the forward proxy (`apps/api/src/proxy/`) handles both —
it intercepts outbound HTTP, blocks non-allowlisted domains, and injects credential
headers.

On Kubernetes, we need the same behavior. Two complementary mechanisms:

1. **Sidecar proxy** — a per-pod container that does allowlist filtering and credential
   injection, same as the Podman forward proxy but running alongside the workload
2. **Baseline NetworkPolicy** — forces all pod egress through the proxy, preventing
   direct IP connections that bypass the proxy (defense in depth)

## Design: Sidecar Proxy

### Why sidecar, not shared service

| Approach        | Pros                                           | Cons                                        |
|-----------------|------------------------------------------------|---------------------------------------------|
| Shared service  | One deployment, shared across pods             | Cross-tenant traffic, scaling, single point of failure, credential isolation |
| Sidecar         | Per-pod isolation, lifecycle tied to pod, no cross-tenant traffic | Slightly more resource usage per pod |

Sidecar wins on isolation — each tenant's proxy only has access to their credentials,
starts/stops with the pod, and there's no cross-tenant routing.

### Architecture

```
┌─────────────────────────────────────────┐
│ Pod                                     │
│                                         │
│  ┌──────────────┐  ┌────────────────┐   │
│  │ main         │  │ proxy          │   │
│  │ (workload)   │──│ (boilerhouse   │   │
│  │              │  │  proxy image)  │   │
│  │ HTTP_PROXY=  │  │                │   │
│  │ localhost:   │  │ :18080         │   │
│  │ 18080        │  │                │   │
│  └──────────────┘  └────────────────┘   │
│         localhost networking             │
└─────────────────────────────────────────┘
```

The proxy container listens on `localhost:18080` within the pod. The main container
has `HTTP_PROXY` / `http_proxy` set to `http://localhost:18080`. Since both containers
share the pod's network namespace, they communicate over localhost.

### Proxy container image

The current forward proxy (`apps/api/src/proxy/proxy.ts`) needs to be packaged as a
standalone container image.

#### Option A: Bun-based image (reuse existing code)

```dockerfile
FROM oven/bun:1-slim
COPY proxy/ /app/
CMD ["bun", "run", "/app/serve.ts"]
```

- `serve.ts` — standalone entrypoint that reads config from env vars / mounted file
- Reuses the existing `ForwardProxy` class with minimal wrapping
- Config via env vars: `PROXY_ALLOWLIST`, `PROXY_CREDENTIALS` (JSON)

#### Option B: Off-the-shelf proxy (squid/mitmproxy) with generated config

- Simpler image, no custom code in the sidecar
- Loses credential injection — would need a separate mechanism
- Not recommended since credential injection is a core requirement

**Recommendation: Option A** — reuse the existing proxy code.

### New package: `packages/proxy-sidecar/`

```
packages/proxy-sidecar/
  package.json
  Dockerfile
  src/
    serve.ts          Standalone proxy server, reads config from env/file
    config.ts         Parse sidecar config from env vars
```

Dependencies: extract the proxy logic from `apps/api/src/proxy/` into a shared
package, or duplicate the minimal subset needed for the sidecar.

### Credential resolution

The current proxy resolves `${global-secret:NAME}` templates at request time by
calling back to the `SecretStore`. In a sidecar, the proxy doesn't have access to
the API server's SecretStore.

**Solution:** Resolve credentials at pod creation time. The `KubernetesRuntime.create()`
method already has access to the workload config. For restricted workloads:

1. Resolve all `${global-secret:NAME}` and `${tenant-secret:NAME}` references to
   their actual values
2. Pass resolved credentials to the sidecar via a mounted Secret or env vars
3. The sidecar proxy uses the pre-resolved values directly (no template resolution)

This means secrets are baked into the pod spec (as K8s Secrets, not plaintext env
vars). This is acceptable — K8s Secrets are the standard mechanism for passing
sensitive data to pods.

#### K8s Secret per pod

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: svc-{instanceId}-proxy
  namespace: boilerhouse
stringData:
  config.json: |
    {
      "allowlist": ["api.anthropic.com", "api.openai.com"],
      "credentials": [
        {
          "domain": "api.anthropic.com",
          "headers": { "x-api-key": "sk-ant-actual-resolved-value" }
        }
      ]
    }
```

Mounted into the sidecar at `/etc/proxy/config.json`.

### Translator changes

`packages/runtime-kubernetes/src/translator.ts`:

When `workload.network.access === "restricted"`:

1. Add a second container to the pod spec:
   ```typescript
   {
     name: "proxy",
     image: "boilerhouse/proxy-sidecar:latest",
     ports: [{ containerPort: 18080 }],
     volumeMounts: [{ name: "proxy-config", mountPath: "/etc/proxy" }],
   }
   ```

2. Inject `HTTP_PROXY` / `http_proxy` env vars into the main container:
   ```typescript
   { name: "HTTP_PROXY", value: "http://localhost:18080" },
   { name: "http_proxy", value: "http://localhost:18080" },
   ```

3. Add a volume for the proxy config Secret:
   ```typescript
   { name: "proxy-config", secret: { secretName: `svc-${instanceId}-proxy` } }
   ```

### Runtime changes

`packages/runtime-kubernetes/src/runtime.ts`:

In `create()`, for restricted workloads:

1. Resolve credential templates to actual values
2. Create a K8s Secret with the proxy config
3. Create the pod (translator adds sidecar + env vars)

In `destroy()`:

1. Delete the K8s Secret alongside the pod and service

### KubeClient additions

- `createSecret(namespace, secret)` — POST Secret
- `deleteSecret(namespace, name)` — DELETE Secret (ignore 404)

## Design: Baseline NetworkPolicy

A NetworkPolicy that restricts all egress from restricted pods to only:
- DNS (kube-dns, port 53 UDP/TCP) — so the proxy can resolve allowlisted domains
- Localhost (the sidecar proxy) — implicit, pod-internal traffic isn't affected

This prevents the main container from bypassing the proxy via direct IP connections.

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: {instanceId}-restrict
  namespace: boilerhouse
spec:
  podSelector:
    matchLabels:
      boilerhouse.dev/instance-id: {instanceId}
  policyTypes:
    - Egress
  egress:
    # Allow DNS resolution
    - to:
        - namespaceSelector: {}
      ports:
        - protocol: UDP
          port: 53
        - protocol: TCP
          port: 53
    # Allow traffic to allowlisted IPs (resolved at creation time)
    - to:
        - ipBlock:
            cidr: {resolved-ip}/32
      ports:
        - protocol: TCP
          port: 443
```

**CNI dependency:** NetworkPolicy enforcement requires a CNI that supports it
(Calico, Cilium, Weave Net). Minikube's default (kindnet) does NOT enforce
NetworkPolicies. For local dev, the sidecar proxy alone provides the filtering.
The NetworkPolicy is defense-in-depth for production clusters.

### Translator changes

When `workload.network.access === "restricted"`, `workloadToPod()` also returns
a `networkPolicy` object alongside `pod` and `service`.

### Runtime changes

- `create()`: apply the NetworkPolicy after creating the pod
- `destroy()`: delete the NetworkPolicy (ignore 404)

### KubeClient additions

- `createNetworkPolicy(namespace, policy)` — POST NetworkPolicy
- `deleteNetworkPolicy(namespace, name)` — DELETE NetworkPolicy

## Implementation order

1. Extract proxy into a shared/standalone package (`packages/proxy-sidecar/`)
2. Create Dockerfile + `minikube image build` support for the proxy image
3. Add K8s Secret CRUD to KubeClient
4. Update translator to inject sidecar + env vars for restricted workloads
5. Update runtime to create/delete Secrets alongside pods
6. Add NetworkPolicy support (types, client methods, translator)
7. Tests: translator tests for sidecar injection, E2E with restricted workload
8. Verify with the openclaw workload on minikube

## Files to add

| File                                              | Purpose                                      |
|---------------------------------------------------|----------------------------------------------|
| `packages/proxy-sidecar/package.json`             | Package scaffolding                          |
| `packages/proxy-sidecar/Dockerfile`               | Container image for the sidecar proxy        |
| `packages/proxy-sidecar/src/serve.ts`             | Standalone proxy entrypoint                  |
| `packages/proxy-sidecar/src/config.ts`            | Config parsing from env/file                 |

## Files to modify

| File                                              | Change                                       |
|---------------------------------------------------|----------------------------------------------|
| `packages/runtime-kubernetes/src/translator.ts`   | Sidecar container + env injection            |
| `packages/runtime-kubernetes/src/runtime.ts`      | Secret lifecycle, credential resolution      |
| `packages/runtime-kubernetes/src/client.ts`       | Secret + NetworkPolicy CRUD                  |
| `packages/runtime-kubernetes/src/types.ts`        | K8s Secret + NetworkPolicy types             |
