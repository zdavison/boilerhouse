# Simplification Plan

## Context

After an architecture review against our five stated goals:

1. Safely host isolated AI agent containers
2. Allow tenants to claim an agent container
3. Use CRIU checkpointing for fast starts (no cold boot)
4. Idle timeout → hibernate (snapshot) inactive containers
5. Route messages from external triggers to tenants, auto-claiming

Several components were identified as either over-engineered or reinventing existing tools. This document tracks what to simplify, what stays, and why.

---

## What We're Keeping (and Why)

| Component | Rationale |
|-----------|-----------|
| **Trigger gateway + adapters** | Agent orchestration almost always needs external event sources (Telegram, Slack, webhooks, cron). This is product scope, not accidental complexity. |
| **boilerhouse-podmand daemon** | Security boundary: the daemon runs rootful, the API server does not. This prevents the API process (which handles untrusted tenant requests) from ever having direct root access to the Podman socket. Keep as-is. |
| **CRIU checkpoint/restore** | Core value prop. No off-the-shelf library wraps this. Custom code is justified. |
| **Runtime interface abstraction** | Clean, small, testable. FakeRuntime is essential for CI. |
| **Workload schema** | Domain-specific config format, necessary. |
| **Tenant claim fallback chain** | Existing → tenant snapshot → golden+data → golden → cold. This logic is the product. |
| **Idle monitor (dual-timer)** | Timeout + heartbeat combination is specific to container hibernation semantics. |

---

## Simplifications

### 1. Replace `runtime-kubernetes` with Virtual Kubelet — conditional on what the major user needs

**What the current K8s runtime actually delivers:**

The `KubernetesRuntime` (`packages/runtime-kubernetes/`) advertises `capabilities: { goldenSnapshots: false }`. This means:

- No CRIU. The `snapshot()` method saves `workload.json` + a `tar` of overlay dirs to disk — it is not a memory checkpoint.
- `restore()` cold-boots a new Pod then unpacks the tar back in — no faster than a plain cold boot.
- The entire tenant claim fast path (golden snapshot → fast restore) is bypassed for all K8s users.
- Port access uses spawned `kubectl port-forward` subprocesses.

So currently the K8s runtime gives K8s tenants cold boots only. The core value prop (CRIU fast starts, idle hibernation) does not apply.

**What the Virtual Kubelet approach would deliver:**

K8s schedules pods onto boilerhouse nodes. The nodes run Podman + CRIU. K8s provides scheduling, autoscaling, and visibility; Podman+CRIU does the actual execution. K8s tenants get golden snapshots, fast restores, and idle hibernation — the full product.

This is already designed in `docs/plans/virtual-kubelet-podman.md`.

**Net code change if switched:**

- Remove `packages/runtime-kubernetes/`: −~1300 LOC (runtime, translator, client, minikube image provider, in-cluster auth, types, tests)
- Add `apps/virtual-kubelet-provider/`: +~450 LOC (8 HTTP handlers translating pod lifecycle to claim/release API calls)
- Net: approximately −850 lines. The VK provider is simpler because it doesn't translate the full workload schema to Pod spec — it just extracts a tenant ID from an annotation and a workload name from a label.

**Decision: keep `runtime-kubernetes` as-is.**

The major planned K8s user needs tenant claiming, idle timeout, trigger routing, and filesystem-level snapshots on hibernate/release — but not CRIU fast starts. The current K8s runtime delivers all of that. `capabilities: { goldenSnapshots: false }` already correctly signals that the golden snapshot fast-start path doesn't apply.

Switching to Virtual Kubelet would add a Go binary dependency, RBAC setup, and node pool operational overhead — all in service of delivering CRIU, which this user doesn't need. That's operational complexity with no return.

The VK plan (`docs/plans/virtual-kubelet-podman.md`) remains available if a future user requires K8s scheduling + CRIU fast starts simultaneously.

**No action required.**

---

### 2. Replace custom snapshot crypto with `age`

**Problem:** `packages/core/src/archive-crypto.ts` hand-rolls AES-256-GCM with a custom binary header format (magic bytes, version field, algorithm byte, IV). `packages/runtime-podman/src/hmac.ts` adds HMAC-SHA256 signing on top. This is ~300 lines of custom cryptography that must be maintained, versioned, and audited.

Specific risks:
- Custom binary header format requires version migration logic over time
- AES-GCM nonce reuse (even probabilistically) is catastrophic — the hand-rolled code generates random IVs, which is correct, but any mistake here is silent data exposure
- No external audit

**Solution:** Replace both with [`age`](https://age-encryption.org/) via the `age` CLI or the `@nicolo-ribaudo/age-encryption` npm package.

- `age` uses X25519 + ChaCha20-Poly1305 (modern, audited, nonce-misuse resistant in its stream mode)
- Built-in support for passphrase-based encryption (scrypt) or public key encryption
- No custom header format — `age` handles framing, versioning, and integrity internally
- HMAC signing is redundant once the ciphertext has an authenticated encryption tag — drop `hmac.ts`

**Migration path:**
- Snapshots are transient (expire on their own schedule) — no need to decrypt existing archives
- Add `age` encryption on write, `age` decryption on read, delete `archive-crypto.ts` and `hmac.ts`
- Store the encryption key as a passphrase-based recipient (or generate a keypair and store the private key in `BOILERHOUSE_ENCRYPTION_KEY`)

**Action:**
- [ ] Add `age-encryption` (or shell out to `age` CLI) as a dependency in `packages/runtime-podman`
- [ ] Replace `archive-crypto.ts` encrypt/decrypt calls with `age` equivalents
- [ ] Delete `packages/core/src/archive-crypto.ts`
- [ ] Delete `packages/runtime-podman/src/hmac.ts`
- [ ] Remove `archiveHmac` and `encrypted` fields from `SnapshotRef` (replace with a single `encryptedWithAge: boolean` or just always encrypt if key is present)
- [ ] Update `BOILERHOUSE_ENCRYPTION_KEY` docs — the key is now an `age` identity file or passphrase, not a raw hex AES key

---

### 3. Envoy sidecar — keep, but scope `rewrite-checkpoint.ts`

**Decision: keep Envoy.**

Transparent header injection (e.g., adding `Authorization: Bearer <token>` to outbound HTTP requests without modifying workload code) is a confirmed requirement. This is L7 — it cannot be done with nftables, network namespaces, or DNS filtering. Envoy is the right tool.

`packages/envoy-config/` and the sidecar wiring in `packages/runtime-podman/src/runtime.ts` stay.

**The one remaining concern: `rewrite-checkpoint.ts`**

This file exists solely because CRIU captures the sidecar's port mappings at checkpoint time, and they need to be rewritten on restore. It's non-trivial and a recurring bug surface. This is not a reason to remove Envoy, but it is worth tracking as technical debt — if a cleaner CRIU restore path emerges (e.g., always allocating the same host ports), the rewrite step could be eliminated.

**No action required on Envoy itself.**

---

### 4. Secret store — keep, only update crypto

**Decision: keep the secret store and `${global-secret:KEY}` / `${tenant-secret:KEY}` syntax.**

The purpose of `${global-secret:KEY}` is to give all containers access to a shared resource (e.g., an LLM API key) without the container ever seeing the raw value. The full chain is a deliberate security boundary:

1. Secret stored encrypted in SQLite — not visible to tenants via API
2. Resolved at claim time into the Envoy bootstrap config — never written to the container's environment
3. Envoy injects it as an HTTP header on outbound requests — the container makes calls to e.g. `api.openai.com` without any knowledge of the key

Injecting via env var would defeat this: any code in the container could read `process.env`. The Envoy header injection path is the only way to enforce this boundary.

`templates.ts`, the `tenantSecrets` table, and the `${...}` reference syntax all stay.

**The only action here is the crypto replacement from item #2** — once `archive-crypto.ts` is replaced with `age`, update the per-row encryption in the secret store to match. The storage model and reference syntax are unchanged.

**Action:**
- [ ] After crypto replacement (#2): update secret store row encryption to use `age` instead of hand-rolled AES-GCM

---

## What We're Not Simplifying

### The FSM engine

`packages/core/src/state-machine.ts` is ~80 lines and is used across five domain entities. It's small enough that replacing it with inline `if/switch` would not meaningfully reduce complexity, and the explicit transition maps are useful documentation. Leave it.

### The trigger adapters

Slack, Telegram, webhook, cron. These are product features. The session manager (WebSocket pooling) is justified given that agent interactions are stateful. Leave as-is.

### The boilerhouse-podmand daemon

The security boundary is intentional. The daemon is the only rootful process; the API runs unprivileged. Leave as-is.

---

## Summary

After working through all items, one actionable simplification remains:

**Replace custom crypto with `age`** (item #2 above, plus the secret store follow-on in item #4).

Everything else was either justified on review or resolved as "no action". The crypto replacement is the only real work.
