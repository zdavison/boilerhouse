# Container Isolation for AI Coding Agents

## Threat Model

The workloads running in Boilerhouse are AI coding agents. The threat model differs from
traditional multi-tenant isolation:

- **The agent is cooperative but directable.** An agent can be prompted ("jailbroken") to
  attempt actions outside its intended scope — reading host files, exfiltrating secrets,
  making network requests to unallowed destinations.
- **The agent executes arbitrary code.** Code generation + execution is the core use case.
  This means the container regularly runs untrusted programs.
- **The threat is lateral, not inbound.** The attacker is already inside the container. The
  defences are about containment, not perimeter.

The security goal is: **a fully jailbroken agent running arbitrary code inside the container
cannot reach the host, other tenants, or the network beyond the configured allowlist.**

---

## Why Kata Containers and gVisor Don't Apply Here

Both are excellent isolation runtimes, but both are incompatible with our core requirement:
**CRIU-based checkpoint/restore**.

- **Kata Containers** runs each container inside a lightweight VM (QEMU/firecracker). CRIU
  works by ptrace-inspecting a process tree within a shared kernel. Kata processes live in a
  separate VM kernel, making host-side CRIU impossible. (There is experimental in-VM CRIU
  support, but it is not production-ready and requires coordination between the host and VM
  layers that Podman does not provide.)
- **gVisor** interposes a userspace kernel between the container and the host kernel. gVisor
  has its own snapshot mechanism (`runsc checkpoint`) which is incompatible with CRIU image
  format. Restoring a gVisor checkpoint requires gVisor — there is no interoperability.

These would become viable if Boilerhouse ever moves from CRIU to VM-snapshot-based
hibernation (e.g. live migration of VMs). Until then, the isolation stack must stay within
the standard Linux namespace model that CRIU understands.

**Bubblewrap** (bwrap) is used internally by rootless Podman but is not directly applicable
to our rootful setup; Podman already provides equivalent namespace sandboxing.

---

## Isolation Stack (CRIU-compatible)

The layers below are all compatible with CRIU checkpoint/restore and stack independently.
Each adds a distinct containment guarantee.

### Layer 1 — Seccomp Profile

A restrictive seccomp profile filters which syscalls container processes can invoke. This is
the most effective single control against privilege escalation from inside the container.
CRIU handles seccomp correctly: it captures the profile at checkpoint time and restores it
on resume.

Start from the Docker default seccomp profile and harden further for an AI coding agent
use case (compiling, running scripts, editing files, making HTTP/S requests):

**Block in addition to Docker defaults:**

| Syscall             | Why                                                            |
|---------------------|----------------------------------------------------------------|
| `ptrace`            | Cannot be used to inspect/modify other processes               |
| `process_vm_readv`  | No cross-process memory reads                                  |
| `process_vm_writev` | No cross-process memory writes                                 |
| `bpf`               | No eBPF programs (kernel code execution vector)                |
| `perf_event_open`   | No performance counters (side-channel risk)                    |
| `userfaultfd`       | No user-space page fault handling (exploited in escapes)       |
| `keyctl`            | No kernel keyring access                                       |
| `add_key`           | No kernel keyring writes                                       |
| `request_key`       | No kernel keyring reads                                        |
| `mount` / `umount2` | No filesystem mounting                                         |
| `unshare`           | No new namespace creation from inside the container            |
| `setns`             | Cannot join other namespaces                                   |
| `pivot_root`        | Cannot change root filesystem                                  |
| `syslog`            | No kernel log access                                           |
| `acct`              | No process accounting                                          |
| `settimeofday`      | Cannot modify system clock                                     |
| `adjtimex`          | Cannot adjust clock                                            |

The profile is stored at `deploy/seccomp-agent.json` (OCI seccomp spec format) and applied
via the container create spec: `"security_opt": ["seccomp=deploy/seccomp-agent.json"]`.

**CRIU note:** CRIU reads the active seccomp filter from `/proc/<pid>/status` (via
`Seccomp_filters` in newer kernels) and includes it in the checkpoint. The profile is
fully preserved across checkpoint/restore.

---

### Layer 2 — Capability Dropping

Drop all Linux capabilities from the container and add back only what is strictly necessary.
An AI coding agent running user code needs almost none.

**Minimum required capabilities for a coding agent:**

| Capability       | Why needed                                                   |
|------------------|--------------------------------------------------------------|
| (none required)  | Most agents run as a non-root user inside the container      |

If the agent image requires root internally (e.g. for `apt install`), the minimum set is:

| Capability       | Why                                                          |
|------------------|--------------------------------------------------------------|
| `CHOWN`          | File ownership changes inside the container                  |
| `DAC_OVERRIDE`   | File permission override inside the container                |
| `FOWNER`         | Operations on files owned by other UIDs                      |
| `SETUID`/`SETGID`| Switching user inside the container                          |

**Explicitly deny (even if Podman would grant by default):**

`NET_RAW`, `NET_ADMIN`, `SYS_ADMIN`, `SYS_PTRACE`, `SYS_MODULE`, `SYS_RAWIO`,
`SYS_CHROOT`, `SYS_BOOT`, `AUDIT_WRITE`, `MAC_ADMIN`, `MAC_OVERRIDE`.

Applied in `ContainerCreateSpec` via `cap_drop: ["ALL"]` and `cap_add: [<minimum set>]`.

**CRIU note:** CRIU does not require the checkpointed process to have elevated capabilities.
The daemon itself (rootful Podman) provides what CRIU needs. The container's capability set
is preserved in the checkpoint and restored correctly.

---

### Layer 3 — User Namespace (UID Mapping)

Map the container's UID/GID range to a high, unprivileged UID range on the host. This means
container root (uid 0 inside) is uid 100000+ on the host. If a container escape occurs via
a kernel vulnerability, the attacker is still unprivileged on the host.

```
Container uid 0   → Host uid 100000
Container uid 1   → Host uid 100001
...
Container uid 65535 → Host uid 165535
```

Applied via `userns` in the container create spec:
`"userns": { "nsmode": "auto" }` — Podman auto-assigns a safe UID range from
`/etc/subuid` and `/etc/subgid`.

**CRIU compatibility:** CRIU supports user namespace checkpoint/restore from CRIU v3.15+.
The UID mapping is included in the checkpoint image and correctly restored. Requires
`--userns` support in the CRIU version in use (verify with `criu check --feature userns`).

---

### Layer 4 — Read-Only Root Filesystem

Mount the container root filesystem as read-only. Provide writable `tmpfs` mounts for
directories the agent legitimately needs to write to.

```
/ (rootfs)      → read-only
/tmp            → tmpfs (in-memory, wiped on destroy)
/home/agent     → bind-mount of the agent's workspace volume
```

This prevents the agent from modifying system binaries, installing backdoors, or creating
setuid-root executables on the rootfs. Writable state lives only in the explicitly
provisioned locations.

Applied via `"read_only_filesystem": true` and `mounts` in the container create spec.

**CRIU note:** Read-only rootfs is preserved in the checkpoint. On restore, the same
read-only rootfs is re-used. Tmpfs contents are included in the CRIU memory image.

---

### Layer 5 — SELinux / AppArmor Labels

On RHEL/Fedora (the target platform for CRIU), Podman automatically applies an MCS-labeled
SELinux context to each container. The label is unique per container and prevents one
container's processes from accessing another's files or memory — even if they share the
same host user.

**Do not disable this.** Avoid `--security-opt label=disable` in any container create path.
The `ContainerCreateSpec` in `client.ts` must not include label-disabling options.

For AppArmor (Ubuntu/Debian hosts): apply the `docker-default` AppArmor profile and layer
the seccomp profile on top.

**CRIU note:** SELinux/AppArmor context is included in the checkpoint and restored correctly
by Podman/CRIU.

---

## Network Isolation

### Current State

The `ForwardProxy` in `apps/api/src/proxy/` is implemented and tested but not wired into
the runtime. It:
- Listens on a configurable TCP port
- Maintains a routing table: `sourceIp → allowedDomains[]`
- Fail-closed: unknown source IPs get `403 Forbidden`
- Handles both HTTP forwarding and HTTPS CONNECT tunnelling
- Supports exact and wildcard domain matching

The workload schema already models three network modes:
- `"none"` — network namespace disabled entirely (implemented in `runtime.ts`)
- `"outbound"` — full outbound access (not yet implemented)
- `"restricted"` — outbound via allowlist (not yet implemented)

### Design: Transparent Proxy via iptables

The most robust network enforcement does not rely on the container respecting `HTTP_PROXY`
environment variables. A jailbroken agent can ignore these. Instead, iptables rules in the
container's network namespace redirect outbound traffic through the proxy at the kernel level.

The flow:

```
Container process
  → outbound TCP :80/:443
  → iptables REDIRECT rule (in container netns)
  → host bridge IP:proxyPort
  → ForwardProxy (source IP check → allowlist)
  → destination or 403
```

This is transparent to the container: the agent makes a normal HTTP/S request, iptables
silently redirects it to the proxy, and the proxy enforces the allowlist. The container
process cannot bypass this without using raw sockets (which are blocked by the seccomp
profile and `NET_RAW` capability drop) or DNS-based routing to a non-standard port (which
would fail because outbound traffic to non-standard ports is also blocked).

**Port rules (nftables/iptables):**

```
# Inside the container's network namespace:
# Redirect HTTP and HTTPS to proxy
-A OUTPUT -p tcp --dport 80  -j REDIRECT --to-port <proxyPort>
-A OUTPUT -p tcp --dport 443 -j REDIRECT --to-port <proxyPort>
# Drop everything else outbound (except loopback and the port exposed to the host)
-A OUTPUT -o lo -j ACCEPT
-A OUTPUT -j DROP
```

These rules are applied by the runtime immediately after container start, using
`nsenter --net=/proc/<pid>/ns/net nft ...` from the host (from the rootful daemon context).

### ForwardProxy Integration Steps

**1. Start the proxy in `server.ts`**

The proxy needs to start before any instances are created and must survive instance
restarts. On startup:
- Bind to the host bridge interface (not `0.0.0.0` — the proxy should not be reachable
  from outside the host).
- Store the proxy port in `RouteDeps` so the runtime can inject it into containers.

**2. Wire proxy into `PodmanRuntime`**

`PodmanRuntime` needs a reference to the `ForwardProxy` and the host bridge IP.

In `create()`:
- For `access === "none"`: no change, `netns: { nsmode: "none" }`.
- For `access === "restricted"` or `"outbound"`: create the container with a bridge network
  (remove `netns: none`), then in `start()` after the container is running:
  - Resolve the container's bridge IP (`inspect → NetworkSettings.Networks.<bridge>.IPAddress`)
  - `proxy.addInstance(containerIp, workload.network.allowlist ?? [])`
  - Apply iptables REDIRECT rules in the container's network namespace

In `destroy()`:
- `proxy.removeInstance(containerIp)` before removing the container.

In `restore()`:
- The container gets a new IP on restore. Re-register the new IP with the proxy and
  re-apply iptables rules (they live in the container netns and are not preserved in CRIU
  checkpoints).

**3. CRIU and iptables rules on restore**

CRIU does preserve network namespace state, but iptables rules are not saved by CRIU (they
are stored in the kernel's netfilter tables, not in the process's state). On restore, the
runtime must re-apply iptables/nftables rules in the restored container's network namespace.
This is a post-restore step in `PodmanRuntime.restore()`.

**4. DNS filtering (optional defence-in-depth)**

Even with iptables-level enforcement, a jailbroken agent might try to use DoH (DNS over
HTTPS to 8.8.8.8:443) or other tunnelling techniques. Supplement the proxy with DNS
filtering:
- Configure the container to use a custom DNS resolver (via `dns` in container create spec).
- The custom resolver only resolves domains that match the allowlist and returns NXDOMAIN
  for everything else.
- Combined with the iptables rules (which block outbound DNS to external servers), this
  prevents DNS-based circumvention.

DNS filtering is a defence-in-depth measure; the iptables redirect is the primary enforcement.

### Network Mode Summary

| `network.access` | Container netns | Proxy registration | iptables rules | DNS |
|------------------|-----------------|--------------------|----------------|-----|
| `"none"`         | disabled        | —                  | —              | —   |
| `"restricted"`   | bridge          | allowlist from workload | REDIRECT :80/:443 | custom resolver |
| `"outbound"`     | bridge          | `["*"]` (pass-all) | REDIRECT :80/:443 | host resolver |

For `"outbound"`, the proxy is still in the path (traffic still goes through it) but the
allowlist is `["*"]`. This ensures all outbound traffic is logged and the proxy can be
tightened later without an architecture change.

---

## Implementation Plan

### Phase 1 — Container hardening (no network changes)

Changes to `packages/runtime-podman/src/`:

1. **Seccomp profile** — create `deploy/seccomp-agent.json` based on Docker's default plus
   the additional blocks listed above.

2. **`ContainerCreateSpec` additions** in `client.ts`:
   ```typescript
   security_opt?: string[];       // ["seccomp=/path/to/profile.json", "no-new-privileges"]
   cap_drop?: string[];           // ["ALL"]
   cap_add?: string[];            // minimum set
   userns?: { nsmode: string };   // "auto"
   read_only_filesystem?: boolean;
   mounts?: Array<{ type: string; target: string; options?: string[] }>;
   ```

3. **`PodmanRuntime.create()` changes** — populate the new fields from workload config.
   Add a `hardened: boolean` flag to `PodmanConfig` (defaults true) so tests can opt out.

4. **`buildCreateBody()` changes** in `client.ts` — pass through the new fields.

5. **Tests** — add tests asserting the hardened spec fields are set when `hardened: true`.

### Phase 2 — Proxy integration

1. **`server.ts`** — instantiate `ForwardProxy`, bind to bridge interface, pass to
   `PodmanRuntime` via `PodmanConfig`.

2. **`PodmanRuntime` additions**:
   - `containerIps: Map<InstanceId, string>` — track container bridge IPs
   - After `start()`: resolve container IP, register with proxy, apply iptables rules
   - After `restore()`: resolve new container IP, re-register, re-apply iptables
   - In `destroy()`: deregister from proxy

3. **iptables helper** — a small module in `packages/runtime-podman/src/netns.ts` that
   applies the REDIRECT rules using `nsenter` + `nft` (or `iptables`). Must be run from the
   rootful daemon context. This is a privileged operation executed via `Bun.$`.

4. **Schema** — `instances` table gets a `container_ip TEXT` column for tracking (needed to
   deregister on destroy if the runtime restarts between start and destroy).

5. **`RouteDeps`** — add `proxy: ForwardProxy | null` to the deps interface, so routes can
   observe proxy state for diagnostics.

### Phase 3 — DNS filtering (optional)

1. Add a lightweight DNS proxy/filter (could be `dnsproxy` or a small Bun DNS server).
2. Configure containers with `dns: [bridgeIp]` and filter queries against the workload
   allowlist.
3. Block outbound port 53 UDP/TCP in the container iptables rules to force DNS through
   the custom resolver.

---

## Risk Tradeoffs

| Control              | Jailbreak resistance                | CRIU impact  | Complexity |
|----------------------|-------------------------------------|--------------|------------|
| Seccomp profile      | High — blocks kernel escape vectors | None         | Low        |
| Cap drop             | High — no privilege escalation      | None         | Low        |
| User namespace       | Medium — limits host escape damage  | Needs v3.15+ | Low        |
| Read-only rootfs     | Medium — no persistence             | None         | Low        |
| SELinux labels       | High — MCS per-container isolation  | None         | None       |
| Proxy (iptables)     | High — kernel-enforced network      | Post-restore step | Medium |
| DNS filtering        | Medium — circumventable with DoH+proxy blocked | None | Medium |
| Kata Containers      | Very high                           | **Incompatible** | High   |
| gVisor               | Very high                           | **Incompatible** | High   |

The recommended stack (Phases 1 + 2) gives strong jailbreak resistance for the actual threat
model (code execution inside a container) while remaining fully CRIU-compatible. The main
gap vs. Kata/gVisor is kernel vulnerability exposure — a container escape via a kernel CVE
is theoretically possible. User namespaces and seccomp together significantly reduce this
surface.
