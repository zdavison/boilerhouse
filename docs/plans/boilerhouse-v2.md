# Boilerhouse v2 — Workload Orchestration Platform for microVMs

## 1. Problem Statement

Many workloads — AI agents, dev environments, sandboxed code execution — have process startup times measured in seconds to tens of seconds (10-20s for a typical AI agent). In a multi-tenant setting where each tenant gets their own isolated instance, this cold-start latency is unacceptable. Tenants expect sub-second response times.

**Boilerhouse solves this by snapshotting fully-initialized workload processes and restoring from those snapshots instead of cold-starting.** A Firecracker snapshot restore takes ~5-10ms — turning a 20-second cold start into a near-instant resume.

Boilerhouse provides:

- **Golden snapshots** — snapshot a workload after its process is fully initialized; every tenant claim restores from this snapshot, never cold-booting
- **Per-tenant snapshots** — when a tenant's instance goes idle, snapshot their unique state (process + memory); when they return, restore exactly where they left off
- **Tenant data persistence** — the tenant's filesystem overlay is saved separately so that even on cold restore (golden snapshot), the tenant's data can be reattached
- **Tenant claiming** — a tenant acquires an instance, which becomes exclusively theirs
- **Network isolation** — workload-level network policies with domain allowlisting via a forward proxy
- **Idle detection** — instances that go quiet are automatically hibernated (snapshot + destroy) or destroyed
- **Runtime abstraction** — same API whether running on Firecracker (Linux) or Apple Virtualization.framework (macOS)

Boilerhouse is **not** application-specific. It doesn't know what runs inside the VMs, how to route messages, or what "processing" means. A consuming application (e.g. an AI agent platform) calls Boilerhouse's API to acquire instances for its tenants, and talks to those instances directly.

**Core KPI: startup time.** Everything else is in service of this. The target is sub-second from claim to a fully-initialized, ready-to-serve instance — regardless of how long the workload takes to cold-start.

**Core constraints:**

- Instances are short-lived and 1:1 with tenants
- Startup must be fast (sub-second target via snapshot restore)
- Must support both Linux (Firecracker) and macOS (Virtualization.framework) runtimes
- Single-node initially, but designed for multi-node expansion

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Consuming Application                    │
│          (e.g. AI agent platform, CI runner, etc.)          │
└──────────────────────────┬──────────────────────────────────┘
                           │ REST API
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                      Boilerhouse API                        │
│                      (Bun.serve, REST)                      │
├──────────┬───────────────┬───────────────┬──────────────────┤
│ Workload │    Instance   │   Snapshot    │   Node           │
│ Registry │    Manager    │   Manager     │   Manager        │
└────┬─────┴───────┬───────┴───────┬───────┴────────┬─────────┘
     │             │               │                │
     │      ┌──────▼───────┐ ┌────▼──────┐  ┌──────▼───────┐
     │      │  Snapshot   │ │ Tenant    │  │  Node        │
     │      │  Manager    │ │ Data Store│  │  Registry    │
     │      └──────┬───────┘ └───────────┘  └──────────────┘
     │             │
     ▼             ▼
┌─────────────────────────────────┐
│        Runtime (interface)      │
├────────────────┬────────────────┤
│  Firecracker   │     VZ         │
│  (Linux/KVM)   │  (macOS/Apple) │
└────────────────┴────────────────┘
```

### Separation of Concerns

| Boilerhouse provides                        | Consumer is responsible for                  |
|---------------------------------------------|----------------------------------------------|
| Workload registration and validation        | Deciding which workload a tenant needs       |
| Instance lifecycle (create, snapshot, etc.)  | Routing traffic to the instance endpoint     |
| Tenant → instance claiming and releasing    | Application-level protocol with the instance |
| Snapshot-based instance creation             | Deciding when to claim/release               |
| Idle detection and automatic hibernation    | Defining idle semantics in the workload spec |
| Snapshot storage and restore                | What runs inside the VM                      |

---

## 3. Core Concepts

### 3.1 Workload

A **workload** is a definition of what runs inside a microVM. It specifies the base image, resource limits, networking, filesystem layout, and idle detection rules. A workload is the *template*; instances are the running copies.

### 3.2 Instance

An **instance** is a running microVM, optionally claimed by a tenant. It goes through these states:

```
                          ┌──────────────────┐
         ┌───restore──────│   hibernated     │◄────idle timeout────┐
         │                └──────────────────┘    (hibernate)       │
         ▼                                                          │
┌─────────────────┐     claim     ┌─────────────────────────────────┤
│    starting      │─────────────►│            active                │
└─────────────────┘               │  (idle timer runs continuously) │
         ▲                        └─────────┬──────────┬────────────┘
         │                                  │          │
    from snapshot                   error/  │          │ idle timeout
    or cold boot                  explicit  │          │ (destroy)
                                            ▼          ▼
                                    ┌────────────┐ ┌──────────────┐
                                    │  stopping   │ │  destroying  │
                                    └──────┬─────┘ └──────┬───────┘
                                           ▼               ▼
                                        (gone)          (gone)
```

There is no separate `idle` state. While an instance is `active`, an idle timer runs continuously. The timer resets whenever filesystem activity is detected on the monitored paths (by polling mtime). When the timer expires without a reset, the workload's `idle.action` fires directly — either transitioning to `hibernated` (snapshot + destroy) or `destroying`.

| State         | Description                                                      |
|---------------|------------------------------------------------------------------|
| `starting`    | VM is booting (cold) or restoring from snapshot                  |
| `active`      | Claimed by a tenant; idle timer running in the background        |
| `hibernated`  | Snapshot saved to disk, VM destroyed, fast restore available     |
| `stopping`    | Graceful shutdown in progress                                    |
| `destroying`  | VM and resources being cleaned up                                |

### 3.3 Tenant

A **tenant** is an opaque identifier provided by the consuming application. Boilerhouse doesn't interpret it — it just tracks which tenant owns which instance. The tenant model provides:

- **Claim**: assign an instance to a tenant (from golden or tenant snapshot restore)
- **Release**: detach a tenant from their instance (triggering hibernate or destroy)
- **Affinity**: if a tenant's snapshot exists, restore it instead of assigning a fresh instance
- **Exclusivity**: one instance per tenant per workload at a time

### 3.4 Runtime

A **runtime** is the hypervisor abstraction. It knows how to create, start, stop, snapshot, and restore microVMs. Two implementations:

- **Firecracker** — Linux/KVM, snapshot restore in ~5-10ms, overlay rootfs. Production runtime.
- **VZ (Virtualization.framework)** — macOS/Apple Silicon, full snapshot/restore via `saveMachineStateTo`/`restoreMachineState` (macOS 14+), block device and network control. Local development runtime.

The VZ runtime is a thin Swift wrapper (~300-500 lines) around Apple's Virtualization.framework, exposed as a local HTTP server or CLI. It maps almost 1:1 to Firecracker's primitives: programmatic VM creation, explicit block device attachment, network device configuration, start/pause/stop, and live state snapshot/restore. This gives developers on macOS a high-fidelity local experience without needing Linux/KVM.

### 3.5 Snapshot

A **snapshot** captures a running instance's full state — memory, CPU registers, device state, and the running process — so it can be destroyed and later restored exactly where it left off. On Firecracker this is a memory + vmstate file pair. On VZ this is a hardware-encrypted state file produced by `saveMachineStateTo`. Both runtimes support full live-state snapshot/restore — the workload process resumes exactly where it was paused, without re-initialization.

There are two kinds of snapshots:

#### Golden Snapshot

A **golden snapshot** is taken after a workload's process has fully initialized and is ready to serve. It captures the "warm, idle, ready" state. When a new tenant claims an instance, Boilerhouse restores from this snapshot — the process is already running, ready to serve, without any cold-start delay.

Golden snapshots are created once per workload version:

```
Cold boot VM → start workload process → wait for health check to pass
→ snapshot the fully-initialized state → this is the golden snapshot
```

#### Tenant Snapshot

A **tenant snapshot** is taken when a specific tenant's instance goes idle. It captures the tenant's unique accumulated state (in-memory context, cached data, filesystem changes). When the tenant returns, their snapshot is restored — resuming not just the process, but their specific session state.

```
Tenant's instance goes idle → snapshot (includes tenant-specific state)
→ destroy VM → tenant returns → restore from their snapshot
```

### 3.6 Node

A **node** is a host machine running a Boilerhouse agent. Initially there is one node. The data model is node-aware from day one so that multi-node expansion doesn't require a schema rewrite.

- Every instance belongs to a node
- Snapshots have node affinity (the files live on that node's local disk)
- Golden snapshots are per-node, per-workload

---

## 4. Workload Definition Format

Workload definitions are TOML files. They are portable across runtimes — the same file works on both Firecracker (Linux) and VZ (macOS) without modification.

The workload references an **OCI image** (or Dockerfile). Boilerhouse converts it to the runtime-specific format at build time. The kernel is managed by Boilerhouse, not by the workload.

```toml
# my-service.workload.toml

[workload]
name = "my-service"
version = "1.0.0"

[image]
# OCI image reference — the single source of truth for what runs inside the VM.
# Same image runs on both Firecracker and VZ.
ref = "ghcr.io/org/my-service:latest"

# OR: build from a Dockerfile (mutually exclusive with ref)
# dockerfile = "./Dockerfile"

[resources]
vcpus = 2
memory_mb = 512
# @default 2 — total ext4 disk image size in GB
disk_gb = 4

[network]
# @default "none" — network access policy: "none", "outbound", or "restricted"
#   none:       no network access (fully isolated)
#   outbound:   unrestricted outbound internet access
#   restricted: outbound only via proxy with domain allowlist (see network.allowlist)
access = "restricted"

# Domain allowlist (only used when access = "restricted").
# Traffic is routed through a forward proxy that enforces this list.
allowlist = ["api.openai.com", "*.amazonaws.com", "ghcr.io"]

# Ports exposed from the guest to the host
expose = [{ guest = 8080, host_range = [30000, 39999] }]

[filesystem]
# Directories to overlay (per-instance writable layer on top of shared base).
# These directories are persisted as the tenant's data overlay.
overlay_dirs = ["/var/data", "/tmp"]
# Directories to mount from the host
bind_mounts = [
  { host = "/srv/shared-assets", guest = "/assets", readonly = true }
]

[idle]
# Directories to monitor for filesystem activity (mtime polling)
watch_dirs = ["/var/data", "/tmp/work"]
# How long without activity before the instance is considered idle
timeout_seconds = 300
# What to do when idle: "hibernate" (snapshot + destroy) or "destroy"
action = "hibernate"

[health]
# Guest-side health endpoint (hit over vsock or guest network).
# Used to know when the golden snapshot can be taken (process fully initialized).
endpoint = "http://localhost:8080/health"
interval_seconds = 10
unhealthy_threshold = 3

[entrypoint]
# Command run inside the guest on boot/restore.
# This is what the OCI image's CMD/ENTRYPOINT would normally be.
cmd = "/usr/bin/my-service"
args = ["--port", "8080"]
# Environment variables injected at start
env = { MODE = "production" }

[metadata]
# Arbitrary key-value pairs passed through to the API (Boilerhouse doesn't interpret these)
description = "My stateful service"
team = "platform"
```

---

## 5. Build Pipeline

`boilerhouse build` converts an OCI image into the artifacts both runtimes need. The output format is the same for both: a raw ext4 disk image.

```
boilerhouse build my-service.workload.toml
```

### What It Does

```
OCI Image (or Dockerfile)
        │
        ▼
┌───────────────────────────────────┐
│ 1. Pull / build the OCI image    │
│    (docker pull or docker build)  │
├───────────────────────────────────┤
│ 2. Export filesystem to tarball   │
│    (docker create + docker export)│
├───────────────────────────────────┤
│ 3. Inject Boilerhouse init       │
│    - Lightweight PID 1 init      │
│    - Mounts /proc, /sys, /dev    │
│    - Configures console (ttyS0   │
│      for FC, hvc0 for VZ)        │
│    - Starts the workload's       │
│      entrypoint                  │
│    - Runs the idle monitor agent │
├───────────────────────────────────┤
│ 4. Create ext4 disk image        │
│    (mkfs.ext4 + extract tar)     │
├───────────────────────────────────┤
│ 5. Create squashfs (optional)    │
│    (for multi-instance CoW)      │
└───────────┬───────────────────────┘
            │
            ▼
  .boilerhouse/artifacts/<hash>/
    ├── rootfs.ext4           # Raw ext4 disk image (universal)
    ├── rootfs.squashfs       # Read-only base for multi-instance (optional)
    └── manifest.json         # Image ref, size, build date, hash
```

### Why Init Injection?

OCI images are designed for containers where the app runs as PID 1. MicroVMs need a proper Linux init that sets up the system (mounts, console, cgroups) before starting the workload process. Boilerhouse injects a lightweight init binary that:

1. Mounts `/proc`, `/sys`, `/dev`, `/tmp`
2. Configures the serial console for the runtime (ttyS0 for Firecracker, hvc0 for VZ)
3. Starts the workload's `[entrypoint]` command
4. Runs the idle monitor agent (mtime polling + vsock/HTTP reporting)

This is the same approach used by E2B, firecracker-containerd, and Apple's Containerization framework.

### Kernels Are Platform-Managed

The workload definition does not specify a kernel. Boilerhouse ships default kernels:

```
.boilerhouse/kernels/
  ├── x86_64/vmlinux      # For Firecracker on x86_64 Linux
  └── arm64/Image          # For Firecracker on ARM64 AND VZ on Apple Silicon
```

Both Firecracker and VZ load the kernel separately from the rootfs — the rootfs contains only the filesystem. The kernel is a Boilerhouse concern, not a workload concern. A single kernel config (with VirtIO drivers compiled in) works for both runtimes.

### Multi-Instance Storage (squashfs + overlay)

For production deployments with many instances of the same workload:

```
Shared read-only base (squashfs)
        │
    ┌───┼───┬───┐
    ▼   ▼   ▼   ▼
  inst1 inst2 inst3 inst4    (per-instance ext4 overlay, writable)
```

100 instances of the same workload share one squashfs base image. Each gets a small ext4 overlay (typically KB-MB) for writes. The guest runs overlay-init to merge them via OverlayFS before starting the workload.

---

## 6. Package Structure

```
boilerhouse/
├── packages/
│   ├── core/                    # Domain types, workload parsing, shared logic
│   │   ├── src/
│   │   │   ├── workload.ts      # Workload definition types + TOML parser
│   │   │   ├── instance.ts      # Instance state machine
│   │   │   ├── runtime.ts       # Runtime interface
│   │   │   ├── snapshot.ts      # Snapshot manager interface
│   │   │   ├── node.ts          # Node types
│   │   │   └── types.ts         # Branded IDs (InstanceId, TenantId, NodeId, etc.)
│   │   └── package.json
│   │
│   ├── build/                   # OCI → ext4 build pipeline
│   │   ├── src/
│   │   │   ├── builder.ts       # Orchestrates the build pipeline
│   │   │   ├── oci.ts           # OCI image pull + export
│   │   │   ├── rootfs.ts        # ext4 / squashfs image creation
│   │   │   └── artifacts.ts     # Content-addressable artifact storage
│   │   └── package.json
│   │
│   ├── guest-init/              # Lightweight init injected into every rootfs
│   │   ├── src/
│   │   │   └── main.c           # PID 1 init (mounts, console, starts workload)
│   │   ├── idle-agent/
│   │   │   └── main.c           # mtime poller + vsock/HTTP reporter
│   │   ├── Makefile             # Cross-compile for x86_64 + arm64
│   │   └── overlay-init.sh      # OverlayFS setup script (squashfs + ext4 merge)
│   │
│   ├── runtime-firecracker/     # Firecracker runtime implementation
│   │   ├── src/
│   │   │   ├── runtime.ts       # FirecrackerRuntime implements Runtime
│   │   │   ├── client.ts        # Firecracker REST API client (Unix socket)
│   │   │   ├── networking.ts    # TAP device setup, iptables rules
│   │   │   └── snapshot.ts      # Firecracker snapshot create/restore
│   │   └── package.json
│   │
│   ├── runtime-vz/              # macOS Virtualization.framework runtime
│   │   ├── src/
│   │   │   ├── runtime.ts       # VzRuntime implements Runtime
│   │   │   └── client.ts        # HTTP client for the Swift VZ helper process
│   │   ├── vz-helper/           # Thin Swift wrapper (~300-500 lines)
│   │   │   ├── Package.swift
│   │   │   └── Sources/
│   │   │       └── main.swift   # Local HTTP server exposing VZ primitives
│   │   └── package.json
│   │
│   └── db/                      # Database schema + migrations
│       ├── src/
│       │   ├── schema.ts        # Drizzle schema
│       │   └── index.ts         # initDatabase, helpers
│       ├── drizzle/             # Migration files
│       └── package.json
│
├── kernels/                     # Pre-built kernels (platform-managed)
│   ├── x86_64/vmlinux           # Firecracker on x86_64
│   ├── arm64/Image              # Firecracker on ARM64 + VZ on Apple Silicon
│   └── config/                  # Kernel configs for reproducible builds
│
├── apps/
│   ├── api/                     # REST API server
│   │   ├── src/
│   │   │   ├── server.ts        # Bun.serve entrypoint
│   │   │   ├── routes/
│   │   │   │   ├── workloads.ts
│   │   │   │   ├── instances.ts
│   │   │   │   ├── tenants.ts
│   │   │   │   ├── nodes.ts
│   │   │   │   └── health.ts
│   │   │   ├── instance-manager.ts # Orchestrates claim/release/snapshot lifecycle
│   │   │   ├── snapshot-manager.ts  # Golden + tenant snapshot management
│   │   │   ├── tenant-data.ts       # Tenant overlay save/restore
│   │   │   ├── idle-monitor.ts      # Watches instances for inactivity
│   │   │   └── network.ts           # Network isolation + proxy management
│   │   ├── test/
│   │   └── package.json
│   │
│   └── dashboard/               # Web UI for monitoring
│       ├── src/
│       │   ├── index.html
│       │   ├── app.tsx
│       │   └── pages/
│       │       ├── Overview.tsx
│       │       ├── WorkloadList.tsx
│       │       ├── WorkloadDetail.tsx
│       │       ├── InstanceList.tsx
│       │       ├── InstanceDetail.tsx
│       │       ├── TenantList.tsx
│       │       └── NodeList.tsx
│       └── package.json
│
├── docs/
│   └── plans/
│       └── boilerhouse-v2.md    # This file
│
└── workloads/                   # Example workload definitions
    └── examples/
        └── echo-server.workload.toml
```

---

## 7. Runtime Interface

The runtime interface is the core abstraction that makes Firecracker and VZ interchangeable:

```typescript
interface Runtime {
  /** Create a new microVM from a workload definition (cold boot). */
  create(workload: Workload, instanceId: InstanceId): Promise<InstanceHandle>

  /** Start a stopped/created instance. */
  start(handle: InstanceHandle): Promise<void>

  /** Stop a running instance gracefully. */
  stop(handle: InstanceHandle): Promise<void>

  /** Destroy an instance and clean up all resources. */
  destroy(handle: InstanceHandle): Promise<void>

  /**
   * Create a snapshot of a running instance.
   * Returns a reference that can be passed to `restore()`.
   */
  snapshot(handle: InstanceHandle): Promise<SnapshotRef>

  /**
   * Restore an instance from a snapshot.
   * Returns a running instance handle.
   */
  restore(ref: SnapshotRef, instanceId: InstanceId): Promise<InstanceHandle>

  /** Get the guest IP / connectivity info for reaching the instance. */
  getEndpoint(handle: InstanceHandle): Promise<Endpoint>

  /** Check if the runtime is available on this host. */
  available(): Promise<boolean>
}
```

### 7.1 Firecracker Implementation

```
FirecrackerRuntime
├── Uses Firecracker REST API over Unix socket
├── create():
│   ├── Allocate TAP device
│   ├── Create overlay rootfs (squashfs base + sparse ext4 layer)
│   ├── PUT /boot-source, /machine-config, /drives, /network-interfaces
│   └── PUT /actions { InstanceStart }
├── snapshot():
│   ├── PATCH /vm { Paused }
│   ├── PUT /snapshot/create { Full, paths }
│   └── Store vmstate + memory files in snapshot storage
├── restore():
│   ├── Allocate TAP device
│   ├── Create new Firecracker process
│   ├── PUT /snapshot/load { paths }
│   └── PATCH /vm { Resumed }
└── destroy():
    ├── Kill Firecracker process
    ├── Remove TAP device
    └── Remove overlay rootfs files
```

### 7.2 VZ Implementation (macOS)

A thin Swift program (`vz-helper`) exposes Apple's Virtualization.framework over a local HTTP API. The TypeScript `VzRuntime` talks to this helper.

```
vz-helper (Swift, local HTTP server)
├── POST /vms              → Create VM (VZVirtualMachineConfiguration)
├── POST /vms/:id/start    → Start VM
├── POST /vms/:id/pause    → Pause VM
├── POST /vms/:id/resume   → Resume VM
├── POST /vms/:id/stop     → Stop VM
├── POST /vms/:id/snapshot → saveMachineStateTo(url:)
├── POST /vms/:id/restore  → restoreMachineState(from:)
└── DELETE /vms/:id        → Destroy VM + clean up

VzRuntime (TypeScript)
├── Spawns vz-helper process on init
├── create():
│   ├── POST /vms with VZDiskImageStorageDeviceAttachment config
│   ├── POST /vms/:id/start
│   └── Configures VZNATNetworkDeviceAttachment for networking
├── snapshot():
│   ├── POST /vms/:id/pause
│   └── POST /vms/:id/snapshot (saveMachineStateTo)
├── restore():
│   ├── POST /vms with snapshot state file
│   ├── POST /vms/:id/restore (restoreMachineState)
│   └── POST /vms/:id/resume
└── destroy():
    └── DELETE /vms/:id
```

**Parity with Firecracker:** Both runtimes support full live-state snapshot/restore. Virtualization.framework's `saveMachineStateTo`/`restoreMachineState` (macOS 14+) captures memory + device state, comparable to Firecracker's vmstate + memory file pair. Restore latency is higher than Firecracker (~100ms vs ~5ms) but still sub-second — adequate for local development.

---

## 8. Tenant Claiming Model

Boilerhouse provides a generic tenant claiming model. The consuming application decides *when* to claim and release — Boilerhouse handles the *how*.

### 8.1 Claim Flow

Every claim restores from a snapshot — either the tenant's own snapshot (hot restore) or the golden snapshot (fresh start). There is no pool of running VMs; instances are created on demand via snapshot restore.

See section 11.2 for the full restore hierarchy diagram. Summary:

| Path                | When                           | Latency       | What the tenant gets                    |
|---------------------|--------------------------------|---------------|-----------------------------------------|
| Existing instance   | Tenant already has one running | Instant       | Same instance, same state               |
| Hot restore         | Tenant snapshot exists         | ~5-10ms (FC)  | Full process state + data               |
| Cold + data restore | Tenant data overlay exists     | ~5-10ms + I/O | Golden snapshot + tenant's filesystem   |
| Fresh start         | First time / no saved state    | ~5-10ms (FC)  | Golden snapshot, clean slate            |

The `source` field in the claim response tells the consumer which path was taken:
- `"existing"` — tenant already had an active instance
- `"snapshot"` — restored from tenant's previous snapshot (full process state + data)
- `"cold+data"` — restored from golden snapshot with tenant's filesystem overlay reattached
- `"golden"` — fresh instance from golden snapshot (no tenant-specific state)

This enables application-level logic (e.g. the consuming app re-sends conversation context when `source` is `"golden"`).
```

### 8.2 Release Flow

When the consumer calls release (or idle timeout fires):

1. If workload `idle.action == "hibernate"`:
   - Save the tenant snapshot (vmstate + memory) for hot restore
   - Save the tenant data overlay to durable storage for cold restore
   - Destroy the VM
2. If workload `idle.action == "destroy"`:
   - Optionally save the tenant data overlay (if tenant data should survive)
   - Destroy the VM. No snapshot.

---

## 9. Idle Detection

Idle detection is not a distinct state — it runs continuously as a background process for every `active` instance. The mechanism is mtime polling.

### How It Works

1. A lightweight **guest-side agent** runs inside the VM. On a configurable interval, it polls the `mtime` of all paths listed in `idle.watch_dirs`.
2. The agent reports the latest mtime over **vsock** (Firecracker) or a **local HTTP endpoint** (VZ) to the host.
3. The **IdleMonitor** on the host side maintains a timer per instance. Each time a new mtime is reported that is newer than the previous one, the timer resets.
4. When the timer expires (`idle.timeout_seconds` with no mtime change), the configured `idle.action` fires directly:
   - `"hibernate"` → snapshot the instance, save the ref against the tenant, destroy the VM.
   - `"destroy"` → destroy the VM directly.

```typescript
interface IdleMonitor {
  /** Start monitoring an instance for idleness. */
  watch(instanceId: InstanceId, config: IdleConfig): void

  /** Stop monitoring (called when instance is explicitly stopped). */
  unwatch(instanceId: InstanceId): void

  /** Register a callback for when an instance goes idle. */
  onIdle(handler: (instanceId: InstanceId, action: IdleAction) => Promise<void>): void
}
```

### Why mtime polling?

Polling mtime is simple, portable, and doesn't require kernel-level hooks. It works identically on both Firecracker and VZ guests. The polling interval (e.g. every 5s) is configurable and the overhead is negligible — a few `stat()` calls per interval.

### Why vsock for reporting?

On Firecracker, vsock provides a direct host↔guest channel that doesn't depend on network setup being complete. The guest-side agent opens a vsock connection to the host and sends periodic mtime reports. On VZ (macOS dev), the same agent reports over a local HTTP endpoint instead.

---

## 10. Network Isolation

Each workload declares a network access policy. Boilerhouse enforces it at the VM level using the host's network stack — the guest cannot bypass it.

### Access Levels

| Level        | What's allowed                                        | How it's enforced                                 |
|--------------|-------------------------------------------------------|---------------------------------------------------|
| `none`       | No network access at all                              | No TAP device attached; VM is fully air-gapped    |
| `outbound`   | Unrestricted outbound internet + exposed ports        | TAP device with NAT; iptables for port forwarding |
| `restricted` | Outbound only to allowlisted domains + exposed ports  | TAP device routed through forward proxy           |

The `none` and `outbound` levels are enforced purely via iptables rules — no proxy involved. The proxy only participates when `access = "restricted"`.

### Restricted Mode (Domain Allowlisting)

When `access = "restricted"`, all outbound traffic from the VM is routed through a **forward proxy** running on the host. The proxy resolves which allowlist to apply based on the **source IP** of each connection — each instance's TAP device has a known IP, which maps to a workload (and in the future, a tenant).

```
Guest VM ──► TAP device ──► iptables DNAT ──► Forward Proxy ──► Internet
(172.16.0.5)                                       │
                                          1. Resolve source IP → instance → workload
                                          2. Look up allowlist for that workload
                                          3. Match domain (Host header or TLS SNI)
                                                   │
                                             ✓ allowed: forward
                                             ✗ blocked: reject
```

#### Proxy Architecture

A single forward proxy process runs per node. It maintains a routing table mapping source IPs to allowlists, updated by the instance manager as instances are created and destroyed:

```
┌──────────────────────────────────────────────────────────────┐
│                    Forward Proxy (per-node)                    │
│                                                                │
│  Routing table (updated via proxy.addInstance / removeInstance) │
│  ┌──────────────┬──────────────────┬────────────────────────┐  │
│  │ Source IP     │ Workload         │ Allowlist              │  │
│  ├──────────────┼──────────────────┼────────────────────────┤  │
│  │ 172.16.0.5   │ my-service       │ [api.openai.com, ...]  │  │
│  │ 172.16.0.6   │ my-service       │ [api.openai.com, ...]  │  │
│  │ 172.16.0.7   │ code-runner      │ [pypi.org, *.github.*] │  │
│  └──────────────┴──────────────────┴────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
```

The instance manager calls:
- `proxy.addInstance(ip, allowlist)` when creating a `restricted` instance
- `proxy.removeInstance(ip)` when destroying one

This is the same lifecycle pattern as the idle monitor's `watch`/`unwatch`.

#### Why One Proxy Per Node (Not Per Workload)

Different workloads on the same node have different allowlists. Three designs were considered:

| Design                | Pros                                              | Cons                                             |
|-----------------------|---------------------------------------------------|--------------------------------------------------|
| **One proxy per node**    | One process, one port, simple lifecycle       | Routing table lookup per connection              |
| One proxy per workload | Static config, crash isolation                   | N processes, port allocation, doesn't scale to per-tenant |
| One proxy per instance | Maximum isolation                                | Wasteful — one process per VM                    |

One proxy per node wins because:

1. **Per-tenant allowlists are a future requirement.** Per-workload proxies would need to be rearchitected; a routing table handles both per-workload and per-tenant identically (just change the lookup key).
2. **The routing lookup is trivial.** One `Map.get(sourceIP)` per connection — a hash lookup, not real complexity.
3. **Simpler lifecycle.** One long-lived process instead of spawning/killing proxies as workloads are registered/unregistered.
4. **Isolation concern is limited.** The proxy never terminates TLS. A bug means a connection is rejected or forwarded — not data leaking between workloads.

#### HTTP/HTTPS Handling

- **HTTP:** inspects `Host` header, matches against the resolved allowlist
- **HTTPS:** inspects SNI (Server Name Indication) in the TLS ClientHello, matches against the resolved allowlist. The proxy does **not** terminate TLS — it forwards the raw TCP connection if the SNI matches.
- **Wildcard support:** `*.amazonaws.com` matches `s3.amazonaws.com`, `dynamodb.us-east-1.amazonaws.com`, etc.
- **Unknown source IP:** connections from IPs not in the routing table are rejected (fail-closed).

The guest is configured to use this proxy via environment variables (`HTTP_PROXY`, `HTTPS_PROXY`) injected by the init system, and iptables rules on the host redirect traffic to the proxy even if the guest ignores the env vars.

#### Future: DNS-Level Enforcement

For more granular control:
- Run a DNS resolver on the host that only resolves allowlisted domains
- Configure the guest to use this resolver (via DHCP or `/etc/resolv.conf`)
- Combined with iptables rules that block direct IP access, this prevents DNS-based circumvention

#### Future: Per-Tenant Allowlists

The routing table key shifts from `source IP → workload allowlist` to `source IP → tenant allowlist`. The proxy code is unchanged — only the config source changes. The tenant's allowlist could be stored in the `tenants` table or provided at claim time by the consuming application.

### Port Exposure

Ports listed in `network.expose` are forwarded from the host to the guest via iptables DNAT rules. Each instance gets a unique host port from the configured range.

---

## 11. Snapshot-Based Instance Creation

There is no pool of running VMs. Every tenant claim restores directly from a snapshot. This eliminates the complexity of managing pre-warmed instances — no background fill loops, no pool sizing, no idle VM resource consumption.

### 11.1 Golden Snapshot

The golden snapshot is created once per workload version. It captures the workload in a fully-initialized, ready-to-serve state.

```
Golden snapshot creation (once per workload version):
  1. Cold boot a VM with the workload rootfs
  2. Wait for health check to pass (process is fully initialized)
  3. Pause the VM
  4. Snapshot → this is the golden snapshot
  5. Destroy the bootstrap VM
```

This is the only time a cold boot happens. All subsequent tenant claims restore from either this golden snapshot or a tenant-specific snapshot.

### 11.2 Restore Hierarchy

Every tenant claim follows this hierarchy:

```
Tenant claim arrives
        │
        ▼
┌───────────────────────┐  yes   ┌───────────────────────────────────────┐
│ Active instance for   │───────►│ Return endpoint (instant)             │
│ this tenant?          │        │ source: "existing"                    │
└───────┬───────────────┘        └───────────────────────────────────────┘
        │ no
        ▼
┌───────────────────────┐  yes   ┌───────────────────────────────────────┐
│ Tenant snapshot       │───────►│ HOT RESTORE (~5-10ms FC)              │
│ exists?               │        │ source: "snapshot"                    │
│                       │        │ Full process state + data restored    │
└───────┬───────────────┘        └───────────────────────────────────────┘
        │ no
        ▼
┌───────────────────────┐  yes   ┌───────────────────────────────────────┐
│ Tenant data overlay   │───────►│ COLD RESTORE (golden + overlay)       │
│ exists?               │        │ source: "cold+data"                   │
│                       │        │ Data restored, process cold-starts    │
└───────┬───────────────┘        └───────────────────────────────────────┘
        │ no
        ▼
┌───────────────────────┐        ┌───────────────────────────────────────┐
│ Restore from golden   │───────►│ FRESH START (golden only)             │
│ snapshot              │        │ source: "golden"                      │
│                       │        │ No tenant data, process warm          │
└───────────────────────┘        └───────────────────────────────────────┘
```

| Path                | Latency       | What's restored                            |
|---------------------|---------------|--------------------------------------------|
| **Hot restore**     | ~5-10ms (FC)  | Process state + memory + tenant data       |
| **Cold + data**     | ~5-10ms + I/O | Process cold-starts, but tenant data files present |
| **Fresh start**     | ~5-10ms (FC)  | Process warm (golden), no tenant data      |
| **Initial cold boot** | 10-20s     | Only when creating the golden snapshot     |

### 11.3 Tenant Data Persistence

The tenant's filesystem writes are captured in a **per-instance ext4 overlay** (see section 5, Multi-Instance Storage). When an instance is hibernated or destroyed, this overlay file is the tenant's data.

#### Where Tenant Data Lives

```
Instance running:
  squashfs (shared, read-only)  ──┐
                                  ├── OverlayFS merge ──► guest sees unified filesystem
  ext4 overlay (per-instance, rw) ┘
                                  │
                                  ▼
                          This file IS the tenant's data.
                          All writes go here.
```

#### Save and Restore

**On hibernate (idle timeout or explicit release):**

1. Pause the VM
2. Create tenant snapshot (vmstate + memory) — for hot restore later
3. Save the ext4 overlay file to durable storage — for cold restore later
4. Destroy the VM

**On cold restore (no tenant snapshot available, but overlay exists):**

1. Restore from golden snapshot (process starts fresh)
2. Download the tenant's saved overlay from durable storage
3. Mount it as the writable layer on top of the squashfs base
4. The workload process cold-starts but sees the tenant's previous filesystem state

**Storage backends (configurable):**

| Backend       | Phase | Latency        | Use case                           |
|---------------|-------|----------------|------------------------------------|
| Local disk    | 1     | Fast           | Single-node, dev                   |
| S3 / R2       | 2     | ~50-200ms      | Multi-node, durable, cross-region  |
| NFS / EFS     | 2     | ~10-50ms       | Multi-node, lower latency than S3  |

For Phase 1 (single-node), overlays are saved to a local directory. For multi-node, S3 or equivalent object storage provides durability and cross-node access.

#### Overlay Size

The overlay only contains the tenant's writes — not the full filesystem. For a typical workload:
- Base image: 500MB-2GB (shared squashfs, never copied)
- Overlay: KB to tens of MB (only files the tenant changed)
- Upload/download time: negligible for typical overlays

### 11.4 Why No Pool?

A pool of running VMs adds complexity (background fill loops, sizing heuristics, resource consumption for idle VMs, cleanup on crash) without meaningful benefit when snapshot restore is ~5-10ms. Restoring from a golden snapshot on demand is functionally equivalent to acquiring from a pool — the same latency, but zero running VMs when no tenants are active.

---

## 12. Multi-Node Design

### 12.1 Single-Node (Phase 1)

Initially, Boilerhouse runs as a single process on a single host. The API server, snapshot manager, idle monitor, and runtime all live in the same process. The database is local SQLite.

Even in single-node mode, every instance and snapshot record includes a `nodeId`. This is a fixed value derived from the host's identity (hostname or configured ID).

### 12.2 Multi-Node (Future)

When expanding to multiple nodes, the architecture splits into two roles:

```
┌──────────────────────────┐
│     Control Plane        │
│  (scheduler, API, DB)    │
│  Postgres instead of     │
│  SQLite                  │
└──────────┬───────────────┘
           │ gRPC / REST
     ┌─────┼─────────┐
     ▼     ▼         ▼
┌────────┐┌────────┐┌────────┐
│ Node 1 ││ Node 2 ││ Node 3 │
│ Agent  ││ Agent  ││ Agent  │
│ FC/VZ  ││ FC/VZ  ││ FC/VZ  │
└────────┘└────────┘└────────┘
```

**Control plane** owns the global state (which tenants exist, which node has their snapshot) and makes placement decisions. **Node agents** own the local runtime, snapshot storage, and tenant data.

### 12.3 Design Decisions for Multi-Node Readiness

These are things we do in Phase 1 to avoid a rewrite later:

| Decision                              | Rationale                                                            |
|---------------------------------------|----------------------------------------------------------------------|
| `nodeId` on every instance + snapshot | Placement and snapshot affinity require knowing which node owns what |
| All state transitions go through DB   | A future control plane can read the same schema from Postgres        |
| Drizzle ORM (not raw `bun:sqlite`)    | Drizzle supports both SQLite and Postgres with the same schema code  |
| Workload config is declarative TOML   | A scheduler can read requirements without parsing code               |
| Snapshot paths are relative           | Allows moving snapshot storage to shared/networked storage later     |
| No in-memory-only state for instances | Everything recoverable from DB + runtime inspection on restart       |
| Instance manager is stateless         | Derives state from DB; multiple instances can share the same DB      |

### 12.4 Restore Paths: Hot, Warm, and Cold

Tenant snapshots are treated as a **cache** — an optimization, not a correctness requirement. Snapshot loss is not catastrophic; the tenant gets an instance restored from the golden snapshot. If tenant data overlays are saved to durable storage (S3), even a cold restore preserves the tenant's filesystem state.

This section covers the **multi-node** dimension of restore paths. See section 11.2 for the full single-node restore hierarchy.

#### Multi-Node Routing

In a multi-node deployment, the scheduler must decide which node handles a tenant claim:

1. **Preferred**: route to the node holding the tenant's snapshot (hot restore, ~5-10ms)
2. **Fallback**: route to any node, restore from golden snapshot + download tenant data overlay from S3 (cold + data, ~5-10ms + S3 latency)
3. **Future optimization**: migrate tenant snapshot to the requesting node, then hot restore (warm restore, seconds)

The scheduler tries option 1 first. If the snapshot node is full or offline, it falls back to option 2. Tenant data overlays in S3 are the key enabler — they make cold restore viable on any node without needing to migrate the full VM snapshot.

### 12.5 Snapshot Portability

#### Firecracker

Firecracker snapshots **are portable** across hosts under these constraints:

| Constraint             | Details                                                                    |
|------------------------|----------------------------------------------------------------------------|
| CPU architecture       | Must match (x86_64 ↔ x86_64, aarch64 ↔ aarch64)                          |
| CPU model              | Must match, OR use CPU templates to normalize the instruction set          |
| Firecracker version    | Must match (snapshot format is version-specific)                           |
| Host kernel            | Should match (different KVM state semantics across versions)               |

**CPU templates** are Firecracker's mechanism for making heterogeneous fleets appear homogeneous to the guest. Templates like `T2S` (Intel Skylake/Cascade Lake), `T2CL` (Intel Cascade Lake/Ice Lake), and `T2A` (AMD Milan) mask CPU feature differences so that snapshots are portable across those CPU families.

AWS Lambda uses this at massive scale: snapshots are encrypted, stored in a distributed per-AZ cache, and restored on whatever worker node is available.

**Rootfs/overlay images** are plain disk images (ext4) and are freely portable — no constraints.

#### Design Implications for Boilerhouse

To keep snapshots portable across a Firecracker fleet:

1. **Pin Firecracker version** across all nodes (enforced by deployment, verified at node registration)
2. **Use CPU templates** if the fleet has heterogeneous CPUs (configured per-node, recorded in the `nodes` table)
3. **Store snapshot metadata in DB** with enough info to validate compatibility before attempting restore (Firecracker version, CPU template name, architecture)
4. **Compress snapshots for transfer** when migrating between nodes (zstd or lz4; 10-20x compression ratios are typical for memory files)

#### Apple Virtualization.framework (VZ)

VZ snapshots are **not portable**. The `.vzvmsave` file is hardware-encrypted via the Mac's Secure Enclave — no other Mac or user account can read it. This is by design and cannot be worked around.

This is fine because VZ is the local development runtime. In a multi-node production deployment, all nodes would run Firecracker (Linux). VZ snapshots are a local-only cache for the developer's own machine.

### 12.6 Snapshot as Cache — Design Principles

Treating snapshots as a cache (not primary state) drives several architectural choices:

| Principle                                    | Rationale                                                        |
|----------------------------------------------|------------------------------------------------------------------|
| Cold restore is always available             | Golden snapshot restore is ~5-10ms even on cache miss              |
| Snapshot loss is tolerable                   | Tenant gets a fresh instance; consuming app handles re-init      |
| No distributed snapshot replication in v1    | Single-node means all snapshots are local; replication is a multi-node concern |
| Snapshots have a TTL                         | Evict old snapshots via GC; avoids unbounded storage growth      |
| Consuming app must handle cold start         | The app cannot assume snapshot restore; it must work on first boot too |
| `source` field in claim response             | Tells the consumer whether the instance was hot/warm/cold restored, enabling app-level logic |

---

## 13. Database Schema

Using Drizzle ORM. SQLite for single-node, Postgres for multi-node — same schema code for both.

```
┌──────────┐     ┌───────────────┐     ┌──────────────────┐
│ workloads│────►│  instances    │────►│  snapshots       │
└──────────┘     └───────┬───────┘     └──────────────────┘
                         │
                  ┌──────┼──────┐
                  ▼      │      ▼
           ┌──────────┐  │ ┌──────────────┐
           │  nodes   │  │ │ activity_log │
           └──────────┘  │ └──────────────┘
                         ▼
                  ┌──────────────┐
                  │   tenants    │
                  └──────────────┘
```

### Tables

| Table          | Purpose                                                         |
|----------------|-----------------------------------------------------------------|
| `nodes`        | Registered host nodes (single row in Phase 1)                   |
| `workloads`    | Registered workload definitions (parsed from TOML)              |
| `instances`    | All microVM instances and their current state                   |
| `snapshots`    | Snapshot references (file paths, metadata, tenant, node)        |
| `tenants`      | Tenant-to-instance mapping, last active timestamp               |
| `activity_log` | Audit log of instance lifecycle events                          |

### Key Columns

**nodes:**

| Column       | Type      | Description                                       |
|--------------|-----------|---------------------------------------------------|
| `nodeId`     | text (PK) | Branded `NodeId`, derived from hostname or config |
| `runtimeType`| text      | `firecracker` or `vz`                             |
| `capacity`   | text      | JSON: total vCPUs, memory, disk                   |
| `status`     | text      | `online \| draining \| offline`                   |
| `lastHeartbeat`| integer | Timestamp of last health report                   |
| `createdAt`  | integer   | Node registration time                            |

**instances:**

| Column           | Type      | Description                                                          |
|------------------|-----------|----------------------------------------------------------------------|
| `instanceId`     | text (PK) | Branded `InstanceId`                                                 |
| `workloadId`     | text (FK) | Which workload this is an instance of                                |
| `nodeId`         | text (FK) | Which node this instance runs on                                     |
| `tenantId`       | text      | Assigned tenant                                                      |
| `status`         | text      | `starting \| active \| hibernated \| stopping \| destroying`         |
| `runtimeMeta`    | text      | JSON: PID, socket path, TAP device, etc.                            |
| `lastActivity`   | integer   | Timestamp of last activity                                           |
| `claimedAt`      | integer   | When tenant was assigned                                             |
| `createdAt`      | integer   | Instance creation time                                               |

**snapshots:**

| Column         | Type      | Description                                              |
|----------------|-----------|----------------------------------------------------------|
| `snapshotId`   | text (PK) | Branded `SnapshotId`                                     |
| `type`         | text      | `golden` or `tenant`                                     |
| `instanceId`   | text      | Source instance                                          |
| `tenantId`     | text      | Owning tenant (null for golden snapshots)                |
| `workloadId`   | text (FK) | Workload this snapshot is for                            |
| `nodeId`       | text (FK) | Node where snapshot files reside                         |
| `vmstatePath`  | text      | Relative path to vmstate file (Firecracker) or disk image|
| `memoryPath`   | text      | Relative path to memory file (Firecracker only, nullable)|
| `sizeBytes`    | integer   | Total snapshot size                                      |
| `runtimeMeta`  | text      | JSON: Firecracker version, CPU template, architecture    |
| `expiresAt`    | integer   | TTL for snapshot GC (nullable, defaults to config value) |
| `createdAt`    | integer   | When the snapshot was taken                              |

**tenants:**

| Column           | Type      | Description                                      |
|------------------|-----------|--------------------------------------------------|
| `tenantId`       | text (PK) | Branded `TenantId`, opaque to Boilerhouse        |
| `workloadId`     | text (FK) | Which workload this tenant uses                  |
| `instanceId`     | text      | Currently assigned instance (null if hibernated) |
| `lastSnapshotId` | text      | Most recent tenant snapshot for hot restore      |
| `dataOverlayRef` | text      | Reference to saved overlay (local path or S3 URI)|
| `lastActivity`   | integer   | Timestamp of last claim/activity                 |
| `createdAt`      | integer   | First seen                                       |

---

## 14. API Design

Base URL: `/api/v1`

### Workloads

| Method | Path                         | Description                        |
|--------|------------------------------|------------------------------------|
| GET    | `/workloads`                 | List registered workloads          |
| POST   | `/workloads`                 | Register a workload (TOML body)    |
| GET    | `/workloads/:name`           | Get workload details + instance counts |
| DELETE | `/workloads/:name`           | Unregister a workload              |

### Instances

| Method | Path                           | Description                       |
|--------|--------------------------------|-----------------------------------|
| GET    | `/instances`                   | List all instances (filterable)   |
| GET    | `/instances/:id`               | Get instance details              |
| POST   | `/instances/:id/stop`          | Stop an instance                  |
| POST   | `/instances/:id/hibernate`     | Snapshot + destroy                |
| POST   | `/instances/:id/destroy`       | Destroy without snapshot          |

### Tenants

| Method | Path                           | Description                                              |
|--------|--------------------------------|----------------------------------------------------------|
| POST   | `/tenants/:id/claim`           | Claim an instance for this tenant. Returns endpoint.     |
| POST   | `/tenants/:id/release`         | Release the tenant's instance (hibernate or destroy).    |
| GET    | `/tenants/:id`                 | Get tenant state, current instance, snapshot history.    |
| GET    | `/tenants`                     | List all known tenants.                                  |

### Nodes

| Method | Path                           | Description                       |
|--------|--------------------------------|-----------------------------------|
| GET    | `/nodes`                       | List all nodes + status           |
| GET    | `/nodes/:id`                   | Node details, capacity, instances |

### System

| Method | Path                           | Description                       |
|--------|--------------------------------|-----------------------------------|
| GET    | `/health`                      | API health check                  |
| GET    | `/stats`                       | Instance counts, snapshot stats, node utilization |

### Example: Tenant Claim Flow

```
POST /api/v1/tenants/tenant-42/claim
Content-Type: application/json
{ "workload": "my-service" }

Response 200:
{
  "tenantId": "tenant-42",
  "instanceId": "inst-abc123",
  "endpoint": { "host": "172.16.0.5", "port": 8080 },
  "source": "snapshot",
  "latencyMs": 12
}
```

The `source` field tells the consumer how the instance was obtained:
- `"existing"` — tenant already had an active instance
- `"snapshot"` — restored from the tenant's previous snapshot (full state)
- `"cold+data"` — restored from golden snapshot with tenant's filesystem overlay reattached
- `"golden"` — fresh instance from golden snapshot (process warm, no tenant-specific state)

The consumer then talks directly to the returned `endpoint`. Boilerhouse is not in the data path.

---

## 15. Dashboard UI

The dashboard provides real-time visibility into the system. Built with React, served by `Bun.serve` via HTML imports.

### Pages

| Page               | What it Shows                                                    |
|--------------------|------------------------------------------------------------------|
| **Overview**       | Total instances (by state), snapshot stats, recent activity      |
| **Workloads**      | List of registered workloads, resource config, instance counts   |
| **Workload Detail**| Specific workload: active instances, snapshots, config           |
| **Instances**      | Table of all instances with state, tenant, uptime, last activity |
| **Instance Detail**| Resource usage, state history, snapshot info                     |
| **Tenants**        | Tenant list with assigned instances and activity                 |
| **Nodes**          | Node list with capacity, instance count, status                 |

### Real-time Updates

The dashboard connects via WebSocket to receive live state changes:
- Instance state transitions
- Tenant claim/release events
- Idle detection triggers
- Snapshot create/restore events
- Node status changes

---

## 16. Implementation Phases

### Phase 1: Foundation

1. Set up monorepo (Bun workspaces)
2. `packages/core` — types, workload TOML parser, instance state machine
3. `packages/db` — Drizzle schema + migrations (all tables including `nodes`)
4. `packages/guest-init` — lightweight init binary + idle monitor agent
5. Basic API skeleton with `Bun.serve`
6. Unit tests for workload parser and state machine

### Phase 2: Build Pipeline & Firecracker Runtime

1. `packages/build` — OCI → ext4 conversion pipeline (`boilerhouse build`)
2. Init injection into rootfs (guest-init binary + idle agent)
3. `packages/runtime-firecracker` — Firecracker API client over Unix socket
4. Instance lifecycle: create, start, stop, destroy
5. TAP device networking setup
6. Squashfs base + per-instance ext4 overlay
7. Integration tests with a real Firecracker binary

### Phase 3: Snapshots & Tenant Claiming

1. Golden snapshot creation (cold boot → wait for health → snapshot)
2. Snapshot-based instance creation (restore from golden snapshot on claim)
3. Tenant claim/release lifecycle
4. Idle monitor (mtime polling + vsock reporting)
5. Tenant snapshot create/restore through Firecracker
6. Tenant data overlay save/restore (local disk for Phase 1)
7. End-to-end flow: claim → use → idle → hibernate → re-claim → restore

### Phase 4: Network Isolation

1. TAP device setup per access level (none → no TAP, outbound → NAT, restricted → proxy)
2. Forward proxy for domain allowlisting (SNI inspection for HTTPS, Host header for HTTP)
3. iptables rules for traffic redirection through proxy
4. Wildcard domain matching in proxy
5. Port exposure via iptables DNAT rules
6. Integration tests for each access level

### Phase 5: API & Dashboard

1. Full REST API with all routes
2. Dashboard: overview, workloads, instances, tenants, nodes
3. WebSocket for real-time updates
4. Activity log and audit trail

### Phase 6: VZ Runtime (macOS)

1. `packages/runtime-vz/vz-helper` — Swift wrapper around Virtualization.framework
2. `packages/runtime-vz` — TypeScript client for vz-helper HTTP API
3. Live snapshot/restore via `saveMachineStateTo`/`restoreMachineState`
4. Adapt idle reporting for VZ (HTTP endpoint instead of vsock)
5. Test on macOS with Apple Silicon (macOS 14+ required)

### Phase 7: Multi-Node & Durable Storage

1. Node registration and heartbeat
2. Tenant data overlay upload/download to S3 (or R2/NFS)
3. Placement strategy (round-robin, then capacity-aware)
4. Snapshot migration between nodes
5. Switch from SQLite to Postgres for shared state
6. Split into control plane + node agent processes

### Phase 8: Hardening

1. Resource limits enforcement (cgroups v2 for Firecracker)
2. Graceful shutdown and state recovery on process restart
3. Snapshot garbage collection (old/orphaned snapshots)
4. Rate limiting and tenant quotas
5. Metrics and alerting

---

## 17. Key Design Decisions

### Why is Boilerhouse generic (not AI-specific)?

The core primitives — workload definitions, snapshot-based instance creation, tenant claiming, snapshot/restore, idle detection — are useful for any ephemeral-instance use case: CI runners, dev environments, sandboxed code execution, interactive demos. Keeping the orchestrator generic means the same platform serves multiple products.

### Why TOML for workload definitions?

TOML is human-readable, has strong typing (integers, strings, arrays, tables), and is widely used for configuration (Cargo, pyproject, etc.). It's less error-prone than YAML (no implicit type coercion) and more readable than JSON for configuration files.

### Why mtime polling for idle detection?

Polling mtime on specific directories is simple, portable across runtimes, and requires no kernel-level hooks. The guest agent is a trivial loop of `stat()` calls. More sophisticated approaches (inotify, eBPF) add complexity without meaningful benefit — the polling interval (e.g. 5s) is fine-grained enough for idle timeouts measured in minutes.

### Why both golden snapshots AND per-tenant snapshots?

They serve different purposes:

- **Golden snapshot**: captures the workload in a "warm, initialized, ready" state. Every new tenant claim restores from this snapshot. Eliminates the 10-20s cold-start penalty for new tenants who have no prior state. Created once per workload version.
- **Tenant snapshot**: captures a specific tenant's accumulated state (in-memory context, filesystem changes). Used to resume a returning tenant exactly where they left off. Created dynamically when a tenant's instance goes idle.

Both restore in ~5-10ms on Firecracker. A new tenant gets an instance restored from the golden snapshot (warm process, no tenant state). A returning tenant gets their tenant snapshot restored (warm process + their specific state).

### Why treat tenant snapshots as a cache rather than primary state?

Two models exist in practice:
- **Snapshot as primary state** (CodeSandbox): snapshot loss = user loses their session. Requires high reliability and replication.
- **Snapshot as cache** (AWS Lambda): snapshot loss = slower start. System always has a fallback.

Boilerhouse uses the cache model for tenant snapshots. If a tenant snapshot is missing, the tenant gets a fresh instance restored from the golden snapshot — still warm, just without their previous state. The consuming application must handle this case anyway (first-time tenants), so a cache miss uses the same code path. The `source` field in the claim response lets the consumer adapt (e.g. re-hydrate conversation context when `source` is `"golden"`).

This doesn't prevent a consuming application from treating snapshots as important — it just means Boilerhouse itself doesn't guarantee snapshot availability and always has a fallback.

### Why not containers (Docker/Podman)?

Containers share the host kernel, which is insufficient isolation for untrusted workloads. More importantly, containers don't provide **process-level snapshot/restore** — the core feature Boilerhouse depends on. CRIU can checkpoint container processes, but it's complex, fragile, and doesn't work across hosts reliably. Firecracker's VM-level snapshots are simpler (snapshot everything at once) and more robust (the guest kernel handles process state internally).

### Why Virtualization.framework instead of Tart / Lima / OrbStack?

The macOS runtime exists so developers can run Boilerhouse locally. The key requirement is parity with Firecracker's primitives: programmatic VM creation, block device attachment, network configuration, and live snapshot/restore. Evaluated alternatives:

| Option                       | Why not                                                              |
|------------------------------|----------------------------------------------------------------------|
| Tart                         | No live snapshot/restore, CLI-only, Fair Source license               |
| Lima                         | 30-60s boot, designed for long-lived dev VMs, wrong abstraction      |
| OrbStack                     | Proprietary, opaque internals, no snapshot support                   |
| QEMU microvm                 | Heavier, GPL, no native Apple Silicon optimization                   |
| Apple Containerization       | Promising but requires macOS 26, snapshot not yet exposed            |

Virtualization.framework (direct) provides the same primitives as Firecracker: create VM config, attach block devices (`VZDiskImageStorageDeviceAttachment`), attach network (`VZNATNetworkDeviceAttachment`), start/pause/stop, and live snapshot/restore (`saveMachineStateTo`/`restoreMachineState`, macOS 14+). The cost is writing ~300-500 lines of Swift for the helper process, which is a one-time investment.

### Why Drizzle ORM instead of raw bun:sqlite?

Drizzle supports both SQLite and Postgres from the same schema definition. When Boilerhouse moves to multi-node with a shared Postgres database, the schema code doesn't change — only the driver initialization.

### Why node-aware from day one?

Adding `nodeId` to every table later requires a migration on every table plus backfilling. Doing it upfront costs almost nothing (one extra column, always the same value in Phase 1) but saves a painful migration when multi-node ships.

---

## 18. Risks & Mitigations

| Risk                                            | Impact | Mitigation                                                     |
|-------------------------------------------------|--------|----------------------------------------------------------------|
| Snapshot restore fails                           | Medium | Cache model: fallback to cold boot from golden snapshot        |
| Snapshot storage grows unbounded                 | Medium | GC policy: max snapshots per tenant, max age, disk quota       |
| TAP device leaks on ungraceful shutdown          | Medium | Recovery scan on startup: remove orphaned TAP devices          |
| Guest idle watcher crashes                       | Low    | Host-side timeout: no heartbeat for 2x interval → treat as idle|
| VZ restore slower than Firecracker (~100ms vs ~5ms) | Low | Acceptable for local dev; still sub-second                     |
| SQLite → Postgres migration breaks assumptions   | Medium | Use Drizzle ORM from the start; avoid raw SQL; test both       |
| Snapshot affinity pins tenants to nodes           | Medium | Cache model degrades to cold restore; warm restore (migration) is future work |
| CPU model mismatch breaks snapshot portability   | Medium | Pin Firecracker version + use CPU templates across fleet; validate at restore time |
| Too many concurrent instances exhaust host resources | High | Queue with timeout; emit metrics; configurable max_instances   |

---

## 19. Competitive Landscape

### Closest Competitors

| Tool                      | What it does                                                           | Overlap with Boilerhouse                         | Key gap                                              |
|---------------------------|------------------------------------------------------------------------|--------------------------------------------------|------------------------------------------------------|
| **E2B**                   | Firecracker sandboxes for AI agents; pause/resume full VM state (~4s)  | Snapshot/restore, AI agent use case              | Managed service only; no macOS; no idle reaping; no tenant claiming |
| **Fly Machines / Sprites**| Firecracker microVM orchestration with auto-stop, checkpoint/restore   | Idle reaping, snapshot/restore, REST API         | Managed service only; no macOS; disk-only checkpoints (not full process state) |
| **Daytona**               | AI agent sandboxes with pause/fork/snapshot; sub-90ms provisioning     | Snapshot/restore, tenant model, idle handling    | Docker-based not microVM; snapshot branching is early access; not truly cross-platform |
| **Modal**                 | Serverless compute with gVisor snapshots; GPU memory snapshot support  | Process snapshot/restore                         | Proprietary; no self-hosting; container-level not VM-level |
| **Koyeb (Light Sleep)**   | eBPF idle detection + VM snapshot for 200ms wake                       | Idle reaping, snapshot-based hibernation          | Proprietary managed platform only                    |

### Potential Building Blocks

| Tool                               | What it provides                                               | How we could use it                                  |
|-------------------------------------|---------------------------------------------------------------|------------------------------------------------------|
| **Firecracker**                     | Linux microVM with ~5ms snapshot restore                      | Production runtime on Linux                          |
| **Apple Virtualization.framework**  | macOS VM with live save/restore (macOS 14+)                   | Development runtime on macOS                         |
| **libkrun**                         | Cross-platform VMM (Linux KVM + macOS HVF), Apache 2.0       | Potential unified VMM layer (but lacks snapshots)    |
| **CRIU**                            | Process checkpoint/restore on Linux, GPL-2.0                  | Alternative to VM-level snapshots for lighter workloads |
| **Cloud Hypervisor**                | Rust VMM with snapshot/restore and live migration             | Alternative to Firecracker if GPU passthrough needed |

### What Doesn't Exist

Boilerhouse is building something genuinely new — the **combination** of these features in a single, self-hostable, open-source tool:

1. **Cross-platform VM abstraction** (Firecracker + VZ behind a unified API) — no existing tool does this with snapshot support on both sides
2. **Tenant-aware claiming with golden + per-tenant snapshots** — every platform expects you to build tenant mapping yourself
3. **Self-hostable idle reaping with snapshot-hibernate** — Fly and Koyeb have this but it's locked in their managed platforms
4. **Sub-second startup via golden snapshots** — E2B has sandbox templates but not as a self-hostable, on-demand restore primitive

The individual primitives (VMMs, snapshot APIs, CRIU) exist. The orchestration layer that combines them does not.

---

## 20. Implementation Plan

This section is the step-by-step task list for building Boilerhouse v2. **Tests are always written before implementation (TDD).** Each task lists the test files first, then the implementation files.

### Testing strategy

The `Runtime` interface (section 7) is the key test boundary. Everything above it — instance manager, tenant claiming, snapshot manager, idle monitor — is tested against a **FakeRuntime** that simulates VM lifecycle in memory. This gives us fast, deterministic unit tests for all orchestration logic without needing a real hypervisor.

```
                        ┌─────────────────────────────┐
                        │  Unit tests (FakeRuntime)    │
                        │  Fast, deterministic, CI     │
┌───────────────────────┼─────────────────────────────┤
│ Instance Manager      │ ✓                            │
│ Tenant Claiming       │ ✓                            │
│ Snapshot Manager      │ ✓                            │
│ Idle Monitor          │ ✓                            │
│ Forward Proxy         │ ✓ (real TCP, no VMs)         │
│ State Machine         │ ✓                            │
│ Workload Parser       │ ✓                            │
│ DB operations         │ ✓ (in-memory SQLite)         │
├───────────────────────┼─────────────────────────────┤
│                       │  Integration tests           │
│                       │  Requires real binaries       │
├───────────────────────┼─────────────────────────────┤
│ Firecracker Runtime   │ Real Firecracker binary      │
│ VZ Runtime            │ macOS + vz-helper            │
│ Build Pipeline        │ Docker + mkfs.ext4           │
│ Guest Init            │ QEMU or Firecracker          │
│ Network (iptables)    │ Root / netns, real TAP       │
└───────────────────────┴─────────────────────────────┘
```

Integration tests are gated behind environment flags (`BOILERHOUSE_INTEGRATION=1`) and excluded from default `bun test` runs.

---

### Phase 0: Monorepo & Tooling

> Goal: empty monorepo where `bun install` and `bun test` work.

#### 0.1 — Initialize monorepo

```
Files:
  package.json              # Bun workspaces: ["packages/*", "apps/*"]
  tsconfig.json             # Base tsconfig with strict mode, paths
  biome.json                # Linter/formatter config
  .gitignore
  bunfig.toml               # Bun config (if needed)
```

- `bun install` succeeds
- `bun run lint` succeeds (no files to lint yet)

#### 0.2 — Create empty package skeletons

```
Files:
  packages/core/package.json
  packages/core/tsconfig.json
  packages/core/src/index.ts          # empty barrel export

  packages/db/package.json
  packages/db/tsconfig.json
  packages/db/src/index.ts

  packages/build/package.json
  packages/build/tsconfig.json
  packages/build/src/index.ts

  packages/runtime-firecracker/package.json
  packages/runtime-firecracker/tsconfig.json
  packages/runtime-firecracker/src/index.ts

  packages/runtime-vz/package.json
  packages/runtime-vz/tsconfig.json
  packages/runtime-vz/src/index.ts

  apps/api/package.json
  apps/api/tsconfig.json
  apps/api/src/server.ts              # minimal Bun.serve placeholder

  apps/dashboard/package.json
  apps/dashboard/tsconfig.json
  apps/dashboard/src/index.html
```

- `bun test` runs across all packages (no tests yet, exits 0)
- TypeScript compiles cleanly across all packages

---

### Phase 1: Core Types & Domain Logic

> Goal: all domain types, the workload TOML parser, the instance state machine, and the Runtime interface — fully tested, no I/O.

#### 1.1 — Branded ID types

```
Tests:  packages/core/src/types.test.ts
  - branded types are structurally incompatible (InstanceId cannot be passed where TenantId is expected)
  - id factory functions produce correctly branded values
  - ids are string-serializable

Files:  packages/core/src/types.ts
  - InstanceId, TenantId, WorkloadId, NodeId, SnapshotId
  - Factory: generateInstanceId(), generateTenantId(), etc. (nanoid or crypto.randomUUID)
```

#### 1.2 — Workload definition types + TOML parser

```
Tests:  packages/core/src/workload.test.ts
  - parses a minimal valid workload TOML (only required fields)
  - parses a full workload TOML (all optional fields present)
  - rejects missing required fields (name, version, image.ref)
  - rejects invalid combinations (image.ref + image.dockerfile both set)
  - rejects invalid network access values
  - rejects negative resource values
  - parses wildcard allowlist entries (*.amazonaws.com)
  - defaults: disk_gb=2, network.access="none", idle.action="hibernate"
  - preserves metadata passthrough (arbitrary key-value)

Files:  packages/core/src/workload.ts
  - Workload type (mirrors the TOML structure from section 4)
  - parseWorkload(toml: string): Workload — validates and returns typed workload
  - WorkloadParseError with structured error messages

Deps:   smol-toml (TOML parser)
```

#### 1.3 — Instance state machine

```
Tests:  packages/core/src/instance-state.test.ts
  - valid transitions: starting→active, active→hibernated, active→stopping,
    active→destroying, stopping→destroyed, destroying→destroyed,
    hibernated→starting (restore)
  - invalid transitions throw: starting→hibernated, hibernated→active,
    stopping→active, destroyed→anything
  - transition returns the new state (immutable — does not mutate input)
  - all states are enumerable (for exhaustive switch checks)

Files:  packages/core/src/instance-state.ts
  - InstanceStatus = 'starting' | 'active' | 'hibernated' | 'stopping' | 'destroying'
  - InstanceEvent = 'started' | 'claimed' | 'hibernate' | 'stop' | 'destroy' |
    'restore' | 'stopped' | 'destroyed'
  - transition(current: InstanceStatus, event: InstanceEvent): InstanceStatus
  - InvalidTransitionError
```

#### 1.4 — Runtime interface + FakeRuntime

```
Tests:  packages/core/src/fake-runtime.test.ts
  - create() returns a handle with a unique instanceId
  - start() transitions handle to running
  - stop() transitions handle to stopped
  - destroy() removes the instance
  - snapshot() returns a SnapshotRef with paths
  - restore() from a valid SnapshotRef returns a running handle
  - restore() from an invalid SnapshotRef throws
  - getEndpoint() returns a predictable host:port
  - available() returns true
  - operations on a destroyed instance throw

Files:  packages/core/src/runtime.ts
  - Runtime interface (as defined in section 7)
  - InstanceHandle, SnapshotRef, Endpoint types

Files:  packages/core/src/fake-runtime.ts
  - FakeRuntime implements Runtime
  - In-memory Map<InstanceId, FakeInstance>
  - Configurable latency (for testing timeout behavior)
  - Configurable failure injection (for testing error paths)
```

#### 1.5 — Snapshot types

```
Tests:  packages/core/src/snapshot.test.ts
  - SnapshotRef serialization/deserialization
  - golden vs tenant snapshot type discrimination
  - snapshot metadata includes runtimeMeta (FC version, CPU template, arch)

Files:  packages/core/src/snapshot.ts
  - SnapshotType = 'golden' | 'tenant'
  - SnapshotRef (id, type, paths, workloadId, tenantId?, nodeId, runtimeMeta)
  - SnapshotMetadata (FC version, CPU template, architecture)
```

#### 1.6 — Node types

```
Files:  packages/core/src/node.ts
  - NodeStatus = 'online' | 'draining' | 'offline'
  - NodeCapacity { vcpus, memoryMb, diskGb }
  - RuntimeType = 'firecracker' | 'vz'

Tests:  packages/core/src/node.test.ts
  - node status values are exhaustive
  - capacity validation (positive integers)
```

---

### Phase 2: Database

> Goal: Drizzle schema with all tables, migrations, in-memory test helper. Fully tested CRUD for every table.

#### 2.1 — Schema definition

```
Tests:  packages/db/src/schema.test.ts
  - all 6 tables exist (nodes, workloads, instances, snapshots, tenants, activity_log)
  - insert + select round-trips for each table
  - branded ID columns accept branded types
  - timestamp columns round-trip Date objects correctly
  - jsonObject columns round-trip Record objects correctly
  - foreign key constraints reject invalid references
  - unique constraints are enforced (e.g. one active instance per tenant per workload)

Files:  packages/db/src/schema.ts
  - Tables: nodes, workloads, instances, snapshots, tenants, activity_log
  - Custom column types: timestamp (Date↔integer), jsonObject (Record↔text)
  - All ID columns branded via $type<BrandedId>()

Files:  packages/db/src/index.ts
  - initDatabase(path?: string): DrizzleDb
  - createTestDatabase(): DrizzleDb (in-memory, migrations applied)

Deps:   drizzle-orm, drizzle-kit
```

#### 2.2 — Migrations

```
Files:  packages/db/drizzle/0000_initial.sql
  - CREATE TABLE for all 6 tables
  - --> statement-breakpoint between each statement

Files:  packages/db/drizzle.config.ts
  - Drizzle kit config pointing at schema.ts
```

#### 2.3 — Activity log helper

```
Tests:  packages/db/src/activity-log.test.ts
  - log() inserts an event with timestamp
  - log() records instanceId, tenantId, workloadId, event type, metadata
  - query by instanceId returns events in chronological order
  - query by tenantId returns events across instances
  - maxEvents truncation works (oldest events pruned)

Files:  packages/db/src/activity-log.ts
  - ActivityLog class
  - log(db, event: ActivityEvent): void
  - queryByInstance(db, instanceId, limit?): ActivityEvent[]
  - queryByTenant(db, tenantId, limit?): ActivityEvent[]
```

---

### Phase 3: Instance Manager

> Goal: the core orchestration layer that creates, destroys, snapshots, and restores instances. Tested against FakeRuntime + in-memory DB.

#### 3.1 — Instance manager: create & destroy

```
Tests:  apps/api/src/instance-manager.test.ts
  - create() calls runtime.create() + runtime.start()
  - create() inserts a row in the instances table with status='starting'
  - create() transitions to status='active' after start completes
  - create() records the nodeId on the instance
  - create() logs activity (instance.created)
  - destroy() calls runtime.destroy()
  - destroy() updates instance status to 'destroying' then removes the row
  - destroy() logs activity (instance.destroyed)
  - destroy() is idempotent (calling on already-destroyed instance is a no-op)
  - create() with runtime failure rolls back the DB row

Files:  apps/api/src/instance-manager.ts
  - InstanceManager class
  - constructor(runtime: Runtime, db: DrizzleDb, nodeId: NodeId)
  - create(workload: Workload): Promise<InstanceHandle>
  - destroy(instanceId: InstanceId): Promise<void>
```

#### 3.2 — Instance manager: stop & hibernate

```
Tests:  apps/api/src/instance-manager.test.ts (continued)
  - stop() calls runtime.stop(), updates status to 'stopping' then removes row
  - stop() logs activity (instance.stopped)
  - hibernate() calls runtime.snapshot() then runtime.destroy()
  - hibernate() inserts a row in the snapshots table (type='tenant')
  - hibernate() updates instance status to 'hibernated'
  - hibernate() logs activity (instance.hibernated)
  - hibernate() saves the snapshotId on the tenant row
  - hibernate() with snapshot failure falls back to destroy

Files:  apps/api/src/instance-manager.ts (continued)
  - stop(instanceId: InstanceId): Promise<void>
  - hibernate(instanceId: InstanceId): Promise<SnapshotRef>
```

#### 3.3 — Instance manager: restore

```
Tests:  apps/api/src/instance-manager.test.ts (continued)
  - restoreFromSnapshot() calls runtime.restore() with the SnapshotRef
  - restoreFromSnapshot() inserts instance row with status='starting', transitions to 'active'
  - restoreFromSnapshot() assigns the tenantId to the instance
  - restoreFromSnapshot() logs activity (instance.restored, includes snapshot type)
  - restoreFromSnapshot() with invalid/missing snapshot throws SnapshotNotFoundError

Files:  apps/api/src/instance-manager.ts (continued)
  - restoreFromSnapshot(ref: SnapshotRef, tenantId: TenantId): Promise<InstanceHandle>
```

---

### Phase 4: Golden Snapshot Manager

> Goal: create and manage golden snapshots (cold boot → wait for health → snapshot). Tested with FakeRuntime.

#### 4.1 — Golden snapshot creation

```
Tests:  apps/api/src/snapshot-manager.test.ts
  - createGolden() cold boots a VM from the workload definition
  - createGolden() polls the health endpoint until healthy
  - createGolden() snapshots after health check passes
  - createGolden() destroys the bootstrap VM after snapshotting
  - createGolden() stores the snapshot in the snapshots table (type='golden')
  - createGolden() fails if health check never passes (timeout)
  - createGolden() cleans up the bootstrap VM on failure
  - only one golden snapshot per workload+node combination (upsert semantics)

Files:  apps/api/src/snapshot-manager.ts
  - SnapshotManager class
  - constructor(runtime: Runtime, db: DrizzleDb, nodeId: NodeId)
  - createGolden(workload: Workload): Promise<SnapshotRef>
```

#### 4.2 — Health check poller

```
Tests:  apps/api/src/health-check.test.ts
  - polls endpoint at configured interval
  - returns success after first healthy response
  - retries on failure up to unhealthy_threshold consecutive failures
  - times out after configurable deadline
  - supports HTTP health endpoints (200 = healthy)

Files:  apps/api/src/health-check.ts
  - pollHealth(endpoint: string, config: HealthConfig): Promise<void>
  - HealthConfig { interval, unhealthyThreshold, timeoutMs }
```

#### 4.3 — Golden snapshot lookup & validation

```
Tests:  apps/api/src/snapshot-manager.test.ts (continued)
  - getGolden() returns the golden snapshot for a workload+node
  - getGolden() returns null if no golden snapshot exists
  - getGolden() validates runtime metadata compatibility before returning
  - goldenExists() is a fast boolean check

Files:  apps/api/src/snapshot-manager.ts (continued)
  - getGolden(workloadId: WorkloadId, nodeId: NodeId): SnapshotRef | null
  - goldenExists(workloadId: WorkloadId, nodeId: NodeId): boolean
```

---

### Phase 5: Tenant Claiming

> Goal: full tenant claim/release lifecycle with the restore hierarchy from section 11.2. Tested with FakeRuntime + in-memory DB.

#### 5.1 — Tenant claim: restore hierarchy

```
Tests:  apps/api/src/tenant-manager.test.ts
  - claim() when tenant has active instance → returns existing (source: "existing")
  - claim() when tenant snapshot exists → hot restore (source: "snapshot")
  - claim() when tenant data overlay exists → cold restore from golden + overlay (source: "cold+data")
  - claim() when no prior state → fresh from golden (source: "golden")
  - claim() when no golden snapshot exists → throws NoGoldenSnapshotError
  - claim() creates/updates tenant row in tenants table
  - claim() sets instanceId on tenant row
  - claim() sets tenantId on instance row
  - claim() enforces exclusivity: one active instance per tenant per workload
  - claim() returns endpoint info from runtime.getEndpoint()
  - claim() response includes latencyMs (measured wall clock)
  - claim() logs activity (tenant.claimed, includes source)

Files:  apps/api/src/tenant-manager.ts
  - TenantManager class
  - constructor(instanceManager: InstanceManager, snapshotManager: SnapshotManager,
    db: DrizzleDb)
  - claim(tenantId: TenantId, workloadId: WorkloadId): Promise<ClaimResult>
  - ClaimResult { tenantId, instanceId, endpoint, source, latencyMs }
  - ClaimSource = 'existing' | 'snapshot' | 'cold+data' | 'golden'
```

#### 5.2 — Tenant release

```
Tests:  apps/api/src/tenant-manager.test.ts (continued)
  - release() when idle.action="hibernate" → calls instanceManager.hibernate()
  - release() when idle.action="destroy" → calls instanceManager.destroy()
  - release() clears instanceId on tenant row
  - release() preserves lastSnapshotId on tenant row (for future hot restore)
  - release() on a tenant with no active instance → no-op
  - release() logs activity (tenant.released)

Files:  apps/api/src/tenant-manager.ts (continued)
  - release(tenantId: TenantId, workloadId: WorkloadId): Promise<void>
```

#### 5.3 — Tenant data overlay save/restore

```
Tests:  apps/api/src/tenant-data.test.ts
  - saveOverlay() copies the instance overlay file to tenant storage
  - saveOverlay() records the overlay ref on the tenant row (dataOverlayRef)
  - restoreOverlay() retrieves the saved overlay and returns the local path
  - restoreOverlay() returns null when no overlay exists
  - saveOverlay() overwrites previous overlay for same tenant+workload

Files:  apps/api/src/tenant-data.ts
  - TenantDataStore class
  - constructor(storagePath: string, db: DrizzleDb)
  - saveOverlay(tenantId: TenantId, workloadId: WorkloadId, overlayPath: string): void
  - restoreOverlay(tenantId: TenantId, workloadId: WorkloadId): string | null
```

---

### Phase 6: Idle Monitor

> Goal: host-side idle monitoring that triggers hibernate or destroy when an instance goes quiet. Tested with FakeRuntime + timers.

#### 6.1 — Idle monitor core

```
Tests:  apps/api/src/idle-monitor.test.ts
  - watch() starts tracking an instance with the configured timeout
  - unwatch() stops tracking
  - reporting a new mtime resets the idle timer
  - timer expiry with action="hibernate" calls the hibernate handler
  - timer expiry with action="destroy" calls the destroy handler
  - multiple instances tracked independently
  - unwatch() during active timer cancels it cleanly
  - no heartbeat for 2x poll interval → treat as idle (guest agent crash)
  - watch() on an already-watched instance replaces the config

Files:  apps/api/src/idle-monitor.ts
  - IdleMonitor class
  - constructor(config: { defaultPollIntervalMs: number })
  - watch(instanceId: InstanceId, config: IdleConfig): void
  - unwatch(instanceId: InstanceId): void
  - reportActivity(instanceId: InstanceId, mtime: Date): void
  - onIdle(handler: (instanceId: InstanceId, action: IdleAction) => Promise<void>): void
  - stop(): void (cleanup all timers)
```

#### 6.2 — Idle monitor + tenant manager integration

```
Tests:  apps/api/src/idle-integration.test.ts
  - when idle monitor fires "hibernate" → tenant-manager.release() is called
  - when idle monitor fires "destroy" → instance is destroyed, tenant data saved
  - idle monitor is started on claim(), stopped on release()
  - idle monitor uses the workload's idle config (timeout, action, watch_dirs)
```

---

### Phase 7: Network Isolation

> Goal: iptables rule management + forward proxy with source-IP routing. Proxy tested with real TCP connections (no VMs needed). iptables tested in integration only.

#### 7.1 — Forward proxy: core

```
Tests:  apps/api/src/proxy/proxy.test.ts
  - proxy accepts TCP connections and routes based on source IP
  - HTTP request with Host header matching allowlist → forwarded
  - HTTP request with Host header not in allowlist → rejected (403 or connection closed)
  - HTTPS CONNECT with SNI matching allowlist → tunnel established
  - HTTPS CONNECT with SNI not in allowlist → rejected
  - wildcard matching: *.example.com matches sub.example.com
  - wildcard matching: *.example.com does NOT match example.com
  - unknown source IP (not in routing table) → rejected (fail-closed)
  - addInstance() makes new source IP routable
  - removeInstance() makes source IP rejected again
  - concurrent connections from different source IPs use different allowlists

Files:  apps/api/src/proxy/proxy.ts
  - ForwardProxy class
  - constructor(config: { port: number })
  - start(): Promise<void>
  - stop(): Promise<void>
  - addInstance(sourceIp: string, allowlist: string[]): void
  - removeInstance(sourceIp: string): void
```

#### 7.2 — Forward proxy: SNI parser

```
Tests:  apps/api/src/proxy/sni.test.ts
  - extracts SNI from a valid TLS ClientHello
  - returns null for non-TLS data
  - returns null for TLS ClientHello without SNI extension
  - handles multiple extensions (SNI may not be first)
  - handles SNI with multiple names (picks first)

Files:  apps/api/src/proxy/sni.ts
  - parseSni(data: Buffer): string | null
```

#### 7.3 — Forward proxy: domain matcher

```
Tests:  apps/api/src/proxy/matcher.test.ts
  - exact match: "api.openai.com" matches "api.openai.com"
  - exact match: "api.openai.com" does NOT match "evil-api.openai.com"
  - wildcard: "*.amazonaws.com" matches "s3.amazonaws.com"
  - wildcard: "*.amazonaws.com" matches "dynamodb.us-east-1.amazonaws.com"
  - wildcard: "*.amazonaws.com" does NOT match "amazonaws.com"
  - wildcard: "*.example.com" does NOT match "notexample.com"
  - empty allowlist → nothing matches
  - case insensitive matching

Files:  apps/api/src/proxy/matcher.ts
  - matchesDomain(domain: string, allowlist: string[]): boolean
```

#### 7.4 — iptables rule manager (unit logic + integration shell)

```
Tests:  apps/api/src/network/iptables.test.ts (unit — command generation only)
  - generates correct iptables commands for access="none" (no TAP, no rules)
  - generates correct iptables commands for access="outbound" (NAT + forwarding)
  - generates correct iptables commands for access="restricted" (DNAT to proxy)
  - generates correct DNAT rules for port exposure (guest:host mapping)
  - generates cleanup commands that reverse setup commands
  - rules include instance-specific comments for identification

Tests:  apps/api/src/network/iptables.integration.test.ts (gated: BOILERHOUSE_INTEGRATION=1)
  - applies rules in a network namespace and verifies connectivity

Files:  apps/api/src/network/iptables.ts
  - IptablesManager class
  - setupForInstance(instanceId, tapDevice, accessLevel, proxyPort?, portMappings?): string[]
  - teardownForInstance(instanceId): string[]
  - (returns shell commands; caller executes them)
```

#### 7.5 — TAP device manager

```
Tests:  apps/api/src/network/tap.test.ts (unit — command generation)
  - generates correct ip tuntap add command with unique name
  - generates correct ip addr/link commands for setup
  - TAP device names are derived from instanceId (deterministic)
  - generates cleanup commands

Tests:  apps/api/src/network/tap.integration.test.ts (gated: BOILERHOUSE_INTEGRATION=1)
  - creates and destroys a TAP device

Files:  apps/api/src/network/tap.ts
  - TapManager class
  - create(instanceId: InstanceId): Promise<TapDevice>
  - destroy(tapDevice: TapDevice): Promise<void>
  - TapDevice { name, ip, mac }
```

---

### Phase 8: Firecracker Runtime

> Goal: FirecrackerRuntime implements Runtime. Unit tests for API client serialization; integration tests require a real Firecracker binary.

#### 8.1 — Firecracker API client

```
Tests:  packages/runtime-firecracker/src/client.test.ts
  - serializes PUT /boot-source request correctly
  - serializes PUT /machine-config request correctly
  - serializes PUT /drives/:id request correctly
  - serializes PUT /network-interfaces/:id request correctly
  - serializes PUT /actions { InstanceStart } correctly
  - serializes PATCH /vm { Paused | Resumed } correctly
  - serializes PUT /snapshot/create request correctly
  - serializes PUT /snapshot/load request correctly
  - deserializes instance-info response
  - handles error responses (4xx, 5xx) with structured errors

Files:  packages/runtime-firecracker/src/client.ts
  - FirecrackerClient class
  - constructor(socketPath: string)
  - All Firecracker API methods typed and serialized
  - Uses Bun's fetch with unix socket support
```

#### 8.2 — Firecracker runtime: create & destroy

```
Tests:  packages/runtime-firecracker/src/runtime.integration.test.ts
  (gated: BOILERHOUSE_INTEGRATION=1, requires Firecracker binary + KVM)
  - create() boots a VM that responds to health check
  - create() allocates a TAP device
  - create() sets up overlay rootfs
  - destroy() kills the Firecracker process
  - destroy() cleans up TAP device
  - destroy() removes overlay files

Files:  packages/runtime-firecracker/src/runtime.ts
  - FirecrackerRuntime implements Runtime
  - constructor(config: FirecrackerConfig)
  - FirecrackerConfig { binaryPath, kernelPath, snapshotDir, networkConfig }
```

#### 8.3 — Firecracker runtime: snapshot & restore

```
Tests:  packages/runtime-firecracker/src/runtime.integration.test.ts (continued)
  - snapshot() pauses VM, creates vmstate + memory files, resumes or destroys
  - snapshot() files exist at expected paths
  - restore() from snapshot produces a running VM
  - restore() VM responds to health check
  - restore() allocates a new TAP device (different from original)
  - snapshot + restore round-trip: guest state is preserved

Files:  packages/runtime-firecracker/src/runtime.ts (continued)
  - snapshot() and restore() implementations
```

---

### Phase 9: Build Pipeline

> Goal: `boilerhouse build` converts OCI image → ext4 rootfs with injected init. Integration tests require Docker.

#### 9.1 — OCI image pull & export

```
Tests:  packages/build/src/oci.test.ts (gated: BOILERHOUSE_INTEGRATION=1)
  - pulls a public OCI image (e.g. alpine:latest)
  - exports the filesystem to a tarball
  - exported tarball contains expected directories (/bin, /etc, /usr)
  - handles Dockerfile build (docker build + export)
  - rejects invalid image refs

Files:  packages/build/src/oci.ts
  - pullImage(ref: string): Promise<void>
  - exportFilesystem(ref: string, outputTar: string): Promise<void>
  - buildImage(dockerfile: string, outputTar: string): Promise<void>
```

#### 9.2 — Rootfs creation (ext4)

```
Tests:  packages/build/src/rootfs.test.ts (gated: BOILERHOUSE_INTEGRATION=1)
  - creates an ext4 image of configured size from a tarball
  - ext4 image is mountable and contains the tarball contents
  - init binary is injected at the correct path
  - idle agent binary is injected at the correct path
  - overlay-init.sh is injected

Files:  packages/build/src/rootfs.ts
  - createExt4(tarPath: string, outputPath: string, sizeGb: number): Promise<void>
  - injectInit(ext4Path: string, initBinaryPath: string): Promise<void>
```

#### 9.3 — Artifact storage

```
Tests:  packages/build/src/artifacts.test.ts
  - stores artifacts in content-addressable directory
  - manifest.json contains image ref, size, hash, build date
  - duplicate builds produce the same hash (idempotent)
  - getArtifact() returns null for unknown hashes

Files:  packages/build/src/artifacts.ts
  - ArtifactStore class
  - constructor(basePath: string)
  - store(rootfsPath: string, manifest: Manifest): ArtifactRef
  - getArtifact(hash: string): ArtifactRef | null
```

#### 9.4 — Build orchestrator

```
Tests:  packages/build/src/builder.test.ts (gated: BOILERHOUSE_INTEGRATION=1)
  - end-to-end: workload TOML → ext4 rootfs with init injected
  - output directory structure matches spec (.boilerhouse/artifacts/<hash>/)
  - manifest.json is valid

Files:  packages/build/src/builder.ts
  - build(workloadPath: string, outputDir: string): Promise<ArtifactRef>
```

---

### Phase 10: Guest Init

> Goal: PID 1 init binary (C) and idle monitor agent (C). Cross-compiled for x86_64 and arm64.

#### 10.1 — Guest init binary

```
Tests:  packages/guest-init/test/init.test.sh (shell-based, gated: BOILERHOUSE_INTEGRATION=1)
  - binary is statically linked
  - binary runs as PID 1 in a minimal environment (unshare/chroot or QEMU)
  - mounts /proc, /sys, /dev, /tmp
  - starts a configurable entrypoint command
  - forwards SIGTERM to child process
  - exits when child exits

Files:  packages/guest-init/src/main.c
  - Lightweight PID 1 init
  - Mounts filesystems, configures console, exec's entrypoint

Files:  packages/guest-init/Makefile
  - Cross-compile targets for x86_64 and arm64 (musl static)
```

#### 10.2 — Idle monitor agent

```
Tests:  packages/guest-init/test/idle-agent.test.sh (gated: BOILERHOUSE_INTEGRATION=1)
  - polls configured directories for mtime changes
  - reports mtime over vsock (when vsock fd available)
  - reports mtime over HTTP (when HTTP endpoint configured)
  - configurable poll interval
  - handles directories that don't exist yet (waits for creation)

Files:  packages/guest-init/idle-agent/main.c
  - mtime polling loop
  - vsock + HTTP reporting

Files:  packages/guest-init/Makefile (continued)
  - idle-agent target
```

#### 10.3 — Overlay init script

```
Tests:  packages/guest-init/test/overlay-init.test.sh (gated: BOILERHOUSE_INTEGRATION=1)
  - merges squashfs base + ext4 overlay via OverlayFS
  - pivot_root into the merged filesystem
  - writable layer receives writes
  - read-only layer is not modified

Files:  packages/guest-init/overlay-init.sh
```

---

### Phase 11: API Server

> Goal: full REST API from section 14. Tested with in-memory DB + FakeRuntime (no real VMs).

#### 11.1 — Server skeleton + health endpoint

```
Tests:  apps/api/src/routes/health.test.ts
  - GET /api/v1/health returns 200 with { status: "ok" }
  - GET /api/v1/stats returns instance counts, snapshot counts

Files:  apps/api/src/server.ts
  - Bun.serve entrypoint with route registration
  - JSON error handling middleware

Files:  apps/api/src/routes/health.ts
  - GET /health handler
  - GET /stats handler
```

#### 11.2 — Workload routes

```
Tests:  apps/api/src/routes/workloads.test.ts
  - POST /workloads with valid TOML → 201, workload stored
  - POST /workloads with invalid TOML → 400 with parse errors
  - GET /workloads → list of all workloads
  - GET /workloads/:name → workload details + instance counts
  - GET /workloads/:name for nonexistent → 404
  - DELETE /workloads/:name → removes workload (only if no active instances)
  - DELETE /workloads/:name with active instances → 409 Conflict

Files:  apps/api/src/routes/workloads.ts
```

#### 11.3 — Instance routes

```
Tests:  apps/api/src/routes/instances.test.ts
  - GET /instances → list all instances (with status filter query param)
  - GET /instances/:id → instance details
  - GET /instances/:id for nonexistent → 404
  - POST /instances/:id/stop → stops instance, returns 200
  - POST /instances/:id/hibernate → snapshots + destroys, returns 200
  - POST /instances/:id/destroy → destroys, returns 200
  - operations on nonexistent instance → 404

Files:  apps/api/src/routes/instances.ts
```

#### 11.4 — Tenant routes

```
Tests:  apps/api/src/routes/tenants.test.ts
  - POST /tenants/:id/claim with { workload } → ClaimResult (tests all 4 sources)
  - POST /tenants/:id/claim without golden snapshot → 503
  - POST /tenants/:id/release → release, returns 200
  - GET /tenants/:id → tenant state, instance, snapshots
  - GET /tenants → list all tenants
  - GET /tenants/:id for nonexistent → 404

Files:  apps/api/src/routes/tenants.ts
```

#### 11.5 — Node routes

```
Tests:  apps/api/src/routes/nodes.test.ts
  - GET /nodes → list nodes (single node in phase 1)
  - GET /nodes/:id → node details with capacity and instance count
  - GET /nodes/:id for nonexistent → 404

Files:  apps/api/src/routes/nodes.ts
```

#### 11.6 — WebSocket for real-time updates

```
Tests:  apps/api/src/websocket.test.ts
  - client connects to /ws
  - client receives instance state change events
  - client receives tenant claim/release events
  - client receives snapshot create/restore events
  - multiple clients receive the same events
  - client disconnect is handled cleanly

Files:  apps/api/src/websocket.ts
  - EventBus class (in-process pub/sub)
  - WebSocket upgrade handler
  - Event types: instance.*, tenant.*, snapshot.*, node.*
```

---

### Phase 12: Dashboard

> Goal: React dashboard served via Bun HTML imports. Reads from the API.

#### 12.1 — Dashboard skeleton

```
Files:  apps/dashboard/src/index.html
  - HTML shell with <script type="module" src="./app.tsx">

Files:  apps/dashboard/src/app.tsx
  - React app with client-side routing
  - API client hook (fetch wrapper)
  - WebSocket connection for live updates
```

#### 12.2 — Dashboard pages

```
Files:  apps/dashboard/src/pages/Overview.tsx
  - Instance counts by state (pie/bar chart or summary cards)
  - Snapshot stats (count, total size)
  - Recent activity feed

Files:  apps/dashboard/src/pages/WorkloadList.tsx
Files:  apps/dashboard/src/pages/WorkloadDetail.tsx
Files:  apps/dashboard/src/pages/InstanceList.tsx
Files:  apps/dashboard/src/pages/InstanceDetail.tsx
Files:  apps/dashboard/src/pages/TenantList.tsx
Files:  apps/dashboard/src/pages/NodeList.tsx
```

No unit tests for dashboard components in v1 — tested via manual inspection and API integration. Add component tests later if the UI stabilizes.

---

### Phase 13: VZ Runtime (macOS)

> Goal: Virtualization.framework runtime for macOS development. Requires macOS 14+ and Apple Silicon.

#### 13.1 — VZ helper (Swift)

```
Tests:  packages/runtime-vz/vz-helper/Tests/ (Swift XCTest, gated: macOS only)
  - POST /vms creates a VM configuration
  - POST /vms/:id/start boots the VM
  - POST /vms/:id/pause pauses
  - POST /vms/:id/snapshot saves state
  - POST /vms/:id/restore restores state
  - POST /vms/:id/resume resumes
  - DELETE /vms/:id destroys and cleans up

Files:  packages/runtime-vz/vz-helper/Package.swift
Files:  packages/runtime-vz/vz-helper/Sources/main.swift
  - Local HTTP server (~300-500 lines)
  - Maps REST endpoints to Virtualization.framework calls
```

#### 13.2 — VZ runtime client

```
Tests:  packages/runtime-vz/src/client.test.ts (unit — mock HTTP)
  - serializes all requests correctly
  - deserializes all responses
  - handles error responses

Tests:  packages/runtime-vz/src/runtime.integration.test.ts (gated: macOS)
  - create + start + destroy lifecycle
  - snapshot + restore round-trip

Files:  packages/runtime-vz/src/client.ts
Files:  packages/runtime-vz/src/runtime.ts
  - VzRuntime implements Runtime
  - Spawns vz-helper process on init
```

---

### Phase 14: State Recovery & Hardening

> Goal: graceful restart, garbage collection, resource limits.

#### 14.1 — State recovery on restart

```
Tests:  apps/api/src/recovery.test.ts
  - on startup, scans DB for instances with status='active' or 'starting'
  - for each, checks if the runtime still has the VM running
  - if VM exists → update DB to match runtime state
  - if VM gone → mark instance as destroyed, clean up DB row
  - orphaned TAP devices (no matching instance) are cleaned up
  - recovery is idempotent (running twice produces same result)

Files:  apps/api/src/recovery.ts
  - recoverState(runtime: Runtime, db: DrizzleDb, nodeId: NodeId): Promise<RecoveryReport>
  - RecoveryReport { recovered, destroyed, orphanedTapsCleaned }
```

#### 14.2 — Snapshot garbage collection

```
Tests:  apps/api/src/snapshot-gc.test.ts
  - expired snapshots (past expiresAt) are deleted
  - snapshot files are removed from disk
  - snapshot rows are removed from DB
  - golden snapshots are not GC'd if workload is still registered
  - tenant snapshots respect per-tenant max count (keep N most recent)
  - GC is safe to run concurrently with snapshot creation
  - dry run mode reports what would be deleted without acting

Files:  apps/api/src/snapshot-gc.ts
  - SnapshotGC class
  - constructor(db: DrizzleDb, config: GCConfig)
  - run(dryRun?: boolean): Promise<GCReport>
  - GCConfig { maxAgeMs, maxPerTenant, runIntervalMs }
```

#### 14.3 — Instance resource limits

```
Tests:  apps/api/src/resource-limits.test.ts
  - rejects claim when node is at max_instances capacity
  - returns 503 with retry-after header
  - queue with timeout: claim waits up to N seconds for capacity
  - queued claims are served in FIFO order

Files:  apps/api/src/resource-limits.ts
  - ResourceLimiter class
  - canCreate(nodeId: NodeId): boolean
  - waitForCapacity(nodeId: NodeId, timeoutMs: number): Promise<void>
```

---

### Dependency Graph

Tasks must be completed in order within each column. Columns are independent and can be worked in parallel where noted.

```
Phase 0 (monorepo)
    │
    ▼
Phase 1 (core types)
    │
    ├──────────────────────────┐
    ▼                          ▼
Phase 2 (database)        Phase 10 (guest-init, C)
    │                          │
    ▼                          │
Phase 3 (instance manager)    │
    │                          │
    ├──────────┐               │
    ▼          ▼               ▼
Phase 4    Phase 6         Phase 9 (build pipeline)
(snapshots) (idle monitor)     │
    │          │               │
    ▼          │               │
Phase 5 ◄──────┘               │
(tenant claiming)              │
    │                          │
    ├──────────┐               │
    ▼          ▼               ▼
Phase 7    Phase 11        Phase 8 (Firecracker runtime)
(network)  (API server)       │
    │          │               │
    │          ▼               │
    │      Phase 12            │
    │      (dashboard)         │
    │                          │
    ▼                          ▼
Phase 14 ◄─────────────────────┘
(hardening)
                           Phase 13 (VZ runtime — independent, macOS only)
```

### Quick-reference: task count by phase

| Phase | Name                   | Test files | Impl files | Estimated tasks |
|-------|------------------------|------------|------------|-----------------|
| 0     | Monorepo               | 0          | ~15        | 2               |
| 1     | Core types             | 6          | 7          | 6               |
| 2     | Database               | 2          | 4          | 3               |
| 3     | Instance manager       | 1          | 1          | 3               |
| 4     | Golden snapshots       | 2          | 2          | 3               |
| 5     | Tenant claiming        | 2          | 2          | 3               |
| 6     | Idle monitor           | 2          | 1          | 2               |
| 7     | Network isolation      | 5          | 4          | 5               |
| 8     | Firecracker runtime    | 1          | 2          | 3               |
| 9     | Build pipeline         | 4          | 4          | 4               |
| 10    | Guest init             | 3          | 4          | 3               |
| 11    | API server             | 6          | 7          | 6               |
| 12    | Dashboard              | 0          | 8          | 2               |
| 13    | VZ runtime             | 2          | 3          | 2               |
| 14    | Hardening              | 3          | 3          | 3               |
| **Σ** |                        | **39**     | **67**     | **50**          |
