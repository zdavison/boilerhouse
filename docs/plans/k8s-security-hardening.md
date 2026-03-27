# Kubernetes Security Hardening — Learnings from agent-sandbox

## Motivation

Comparing boilerhouse's Kubernetes runtime (`packages/runtime-kubernetes/`) against the
[agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) project reveals significant
gaps in pod security hardening. Agent-sandbox enforces 15+ security controls via a
ValidatingAdmissionPolicy; boilerhouse currently applies only 3 capability drops and
`allowPrivilegeEscalation: false`.

These gaps are not theoretical — a malicious workload on a cloud-hosted cluster could:

- Read node IAM credentials via the metadata server (169.254.169.254)
- Call the Kubernetes API using the auto-mounted service account token
- Escalate to root inside the container
- Access host namespaces (PID, IPC, network) if the pod spec allows it

---

## Current State

`translator.ts` lines 53-62 apply these controls to the main container:

```ts
securityContext: {
    capabilities: { drop: ["NET_RAW", "MKNOD", "AUDIT_WRITE"] },
    allowPrivilegeEscalation: false,
}
```

The Envoy sidecar container (lines 157-167) has **no securityContext at all**.

NetworkPolicy is only created when `proxyConfig` is provided (line 213).

No pod-level security settings are applied (`spec.automountServiceAccountToken`,
`spec.securityContext`, `spec.hostNetwork`, etc.).

---

## Changes

### 1. Drop ALL capabilities (both containers)

**Current:** Drop 3 specific capabilities on main container only.
**Target:** Drop ALL on both main and sidecar containers, add back only what's needed.

**Files:** `translator.ts`, `types.ts`

```ts
// main container
securityContext: {
    capabilities: { drop: ["ALL"] },
    allowPrivilegeEscalation: false,
    runAsNonRoot: true,
    readOnlyRootFilesystem: false,  // workloads may need writable fs
}

// sidecar container (envoy)
securityContext: {
    capabilities: { drop: ["ALL"] },
    allowPrivilegeEscalation: false,
    runAsNonRoot: true,
    readOnlyRootFilesystem: true,
}
```

Envoy needs zero extra capabilities — it binds to a high port (18080) in the
pod network namespace.

**Types change:** Add `runAsNonRoot` and `readOnlyRootFilesystem` to `K8sSecurityContext`.

### 2. Disable service account token auto-mount

**Current:** Not set (defaults to `true` — K8s mounts a token into every pod).
**Target:** `automountServiceAccountToken: false` on the pod spec.

Workloads have no legitimate reason to call the Kubernetes API. The mounted token
is an escalation vector.

**Files:** `translator.ts` (pod spec), `types.ts` (`K8sPodSpec`)

### 3. Block host namespace sharing

**Current:** Not set (defaults to `false`, but should be explicit for defense in depth).
**Target:** Explicitly set on the pod spec:

```ts
hostNetwork: false,
hostPID: false,
hostIPC: false,
```

**Files:** `translator.ts` (pod spec), `types.ts` (`K8sPodSpec`)

### 4. Default-deny NetworkPolicy for all pods

**Current:** NetworkPolicy only created when `proxyConfig` is provided.
**Target:** Always create a NetworkPolicy. Two tiers:

| Workload `network.access` | Egress rules                            |
|----------------------------|-----------------------------------------|
| `"none"`                   | Deny all egress                         |
| `"outbound"`               | Allow DNS + all TCP (current behavior without proxy) |
| `"restricted"`             | Allow DNS + HTTPS only (current proxy behavior)      |

All tiers block access to:
- **Metadata servers:** 169.254.169.254/32 (AWS/GCP), fd00:ec2::254/128 (AWS IMDSv2 IPv6)
- **Link-local:** 169.254.0.0/16
- **Node network (optional):** Consider blocking RFC1918 ranges except the pod/service CIDRs

The metadata server block is the highest-value single change. Without it, any pod on
GKE/EKS/AKS can steal the node's cloud IAM role credentials with a single curl.

**Files:** `translator.ts`, `types.ts` (extend `K8sNetworkPolicy` egress with `ipBlock`)

**Types change:** Add `ipBlock` to the network policy egress `to` array:

```ts
to?: Array<{
    namespaceSelector?: Record<string, never>;
    ipBlock?: { cidr: string; except?: string[] };
}>;
```

### 5. Apply securityContext to sidecar container

**Current:** Envoy sidecar has no securityContext.
**Target:** Same hardening as main container (see step 1), plus `readOnlyRootFilesystem: true`.

**Files:** `translator.ts` lines 157-167

### 6. Pod-level securityContext

**Current:** No pod-level securityContext.
**Target:** Set defaults that apply to all containers in the pod:

```ts
spec: {
    securityContext: {
        runAsNonRoot: true,
        seccompProfile: { type: "RuntimeDefault" },
    },
    ...
}
```

`RuntimeDefault` seccomp profile blocks ~40 dangerous syscalls (e.g. `mount`,
`reboot`, `kexec_load`) with near-zero performance overhead. It's the default on
GKE Autopilot and recommended for all workloads.

**Files:** `translator.ts` (pod spec), `types.ts` (`K8sPodSpec`, new `K8sPodSecurityContext`)

### 7. Block hostPath volumes in type system

**Current:** `K8sVolume` type doesn't include `hostPath`, so it can't be set from our code.
**No code change needed** — this is already safe by construction. Documenting for completeness.

---

## Implementation Order

Steps are ordered by security impact and independence (parallelizable where noted).

| Step | Change                            | Security impact | Effort | Dependencies |
|------|-----------------------------------|-----------------|--------|--------------|
| 1    | Drop ALL caps + runAsNonRoot      | Critical        | Small  | None         |
| 2    | automountServiceAccountToken      | Critical        | Tiny   | None         |
| 3    | Host namespace blocking           | High            | Tiny   | None         |
| 4    | Default-deny NetworkPolicy        | Critical        | Medium | Type changes |
| 5    | Sidecar securityContext           | High            | Small  | Step 1       |
| 6    | Pod-level seccomp + runAsNonRoot  | High            | Small  | Type changes |

Steps 1, 2, 3 can be done in parallel. Step 5 depends on 1 (same pattern).
Step 4 and 6 require type changes first.

---

## Test Plan

All changes are in `translator.ts` and testable via `translator.test.ts` (unit tests,
no live cluster needed).

**New tests:**

- Pod spec has `automountServiceAccountToken: false`
- Pod spec has `hostNetwork: false`, `hostPID: false`, `hostIPC: false`
- Pod spec has `securityContext.seccompProfile.type: "RuntimeDefault"`
- Pod spec has `securityContext.runAsNonRoot: true`
- Main container drops ALL capabilities (not just 3)
- Main container has `runAsNonRoot: true`
- Sidecar container has full securityContext when proxyConfig is provided
- NetworkPolicy is created for all pods, not just proxied ones
- NetworkPolicy blocks 169.254.169.254/32 in all tiers
- NetworkPolicy for `access: "none"` denies all egress
- NetworkPolicy for `access: "outbound"` allows DNS + all TCP
- NetworkPolicy for `access: "restricted"` allows DNS + HTTPS only

**Integration test** (`tests/integration/kubernetes.integration.test.ts`):

- Verify a pod with hardened security context starts and runs successfully
- Verify workloads that require root fail at pod creation (expected)

---

## Not in Scope

These are agent-sandbox features that don't apply here or are deferred:

| Feature                          | Reason                                              |
|----------------------------------|-----------------------------------------------------|
| gVisor/Kata runtime enforcement  | Requires cluster-level setup, not a translator concern |
| ValidatingAdmissionPolicy        | Good for multi-tenant clusters but we control the translator — enforce in code instead |
| SandboxTemplate/Claim separation | Architectural pattern, not a security fix            |
| Warm pool as CRD                 | Already implemented as PoolManager                   |
| Projected volume blocking        | Safe by construction (type system doesn't allow it)  |
| Custom sysctl blocking           | Safe by construction (type system doesn't allow it)  |
