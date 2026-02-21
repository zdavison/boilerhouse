# Firecracker Jailer Integration

## Problem

The API server needs root/sudo to create TAP network devices and manage iptables rules. Currently `setup-dev.sh` works around this with `setcap cap_net_admin+ep` on the `ip` binary, which grants all local users the ability to manipulate network interfaces — unacceptable for production. The jailer is Firecracker's official production isolation mechanism.

## What the Jailer Does

The jailer binary runs as root and performs a hardened sequence before exec'ing into Firecracker as an unprivileged user:

1. Creates chroot at `<base>/<exec_name>/<id>/root/`
2. Copies the Firecracker binary into the chroot
3. Creates device nodes: `/dev/net/tun`, `/dev/kvm`, `/dev/urandom`
4. Sets up cgroups (CPU pinning, memory limits)
5. Joins a pre-existing network namespace (if `--netns` provided)
6. Optionally daemonizes and enters a new PID namespace
7. Drops privileges to specified `uid:gid`
8. `exec()`s into Firecracker

After the jailer runs, the Firecracker process is inside a chroot with no access to the host filesystem, running as an unprivileged user, in an isolated network namespace.

## Current Architecture (What Changes)

```
BEFORE (direct spawn, unprivileged, no isolation):

  API Server (unprivileged)
    └─ Bun.spawn(["firecracker", "--api-sock", "/data/instances/{id}/firecracker.sock"])
    └─ TapManager: ip tuntap add (needs CAP_NET_ADMIN on ip binary)
    └─ All paths absolute on host filesystem

AFTER (jailer, root spawn, full isolation):

  API Server (root, or with sudoers entry for jailer binary only)
    └─ Bun.spawn(["sudo", "jailer", "--id", id, "--exec-file", ..., "--netns", ...])
    └─ Chroot prep: hard-link kernel + rootfs into jail, chown to uid:gid
    └─ Network namespace: created before jailer launch, TAP created inside
    └─ API socket at: /srv/jailer/firecracker/{id}/root/run/firecracker.socket
    └─ All Firecracker-visible paths relative to chroot root
```

## Design Decisions

### D1: Sudo for jailer only

A single sudoers entry grants the API server user passwordless access to the jailer binary and `ip` (for namespace/TAP setup). Nothing else runs as root.

```
boilerhouse ALL=(root) NOPASSWD: /usr/local/bin/jailer, /usr/sbin/ip, /usr/sbin/iptables
```

### D2: Per-VM network namespace

Each VM gets its own network namespace (`fc-{instanceId}`). Inside it:
- A TAP device for the VM
- A veth pair connecting the namespace to the host
- iptables rules scoped to the namespace

This replaces the current host-level TAP + iptables approach with proper namespace isolation.

### D3: Per-VM uid:gid

Each instance gets a unique uid derived from its ID (range 100000–165535, typical subordinate UID range). This prevents cross-VM file access even if a VM escapes its chroot.

### D4: Chroot base directory

`/srv/jailer` (the jailer default). The full jail path is:
```
/srv/jailer/firecracker/{instanceId}/root/
```

### D5: Hard-link resources into jail

Kernel and rootfs are hard-linked (same filesystem) into the chroot. Falls back to `cp --reflink=auto` if cross-filesystem. After linking, files are chowned to the instance uid:gid.

### D6: Snapshots with jailer

Snapshots are taken via the API socket (which is accessible from outside the chroot). Snapshot files (vmstate, memory) are written inside the chroot. After snapshot, we copy them out to the snapshot directory. On restore, we prepare a new jail and copy snapshot files in.

## Implementation Plan

### Phase 1: Jailer Configuration and Types

**Files:** `packages/runtime-firecracker/src/types.ts`

Add jailer-specific config to `FirecrackerConfig`:

```ts
interface JailerConfig {
  /** Path to the jailer binary.
   * @default "/usr/local/bin/jailer" */
  jailerPath: string;

  /** Base directory for chroot jails.
   * @default "/srv/jailer" */
  chrootBaseDir: string;

  /** UID range start for per-VM user isolation.
   * @default 100000 */
  uidRangeStart: number;

  /** GID to use for all jailed processes.
   * @default 100000 */
  gid: number;

  /** Whether to daemonize the jailer process.
   * @default true */
  daemonize: boolean;

  /** Whether to create a new PID namespace.
   * @default true */
  newPidNs: boolean;

  /** Cgroup version (1 or 2).
   * @default 2 */
  cgroupVersion: 1 | 2;
}
```

Extend `FirecrackerConfig`:
```ts
interface FirecrackerConfig {
  // ... existing fields ...
  jailer?: JailerConfig;
}
```

When `jailer` is defined, the runtime uses the jailer path. When undefined, falls back to direct spawn (for dev/testing without root).

### Phase 2: Network Namespace Manager

**New file:** `packages/runtime-firecracker/src/netns.ts`

Replaces the current `apps/api/src/network/tap.ts` for jailer mode. Manages the full network namespace lifecycle.

```ts
interface NetnsConfig {
  /** Host-side bridge or upstream interface for NAT.
   * @default auto-detected from default route */
  uplinkInterface?: string;

  /** Base subnet for inter-namespace veth addressing.
   * @default "10.0.0.0/16" */
  vethSubnet?: string;
}

class NetnsManager {
  /** Create namespace, TAP inside it, veth pair to host, NAT rules. */
  async create(instanceId: InstanceId): Promise<NetnsHandle>;

  /** Delete namespace (TAP and veth are automatically cleaned up). */
  async destroy(handle: NetnsHandle): Promise<void>;

  /** List existing fc-* namespaces (for recovery). */
  async list(): Promise<string[]>;
}

interface NetnsHandle {
  /** Namespace name, e.g. "fc-abc123" */
  nsName: string;
  /** Path to namespace handle: /var/run/netns/fc-abc123 */
  nsPath: string;
  /** TAP device name inside the namespace */
  tapName: string;
  /** TAP device MAC */
  tapMac: string;
  /** Host IP on veth (host side) */
  vethHostIp: string;
  /** Guest IP (inside VM, derived from TAP subnet) */
  guestIp: string;
}
```

**Commands executed by `create()`:**

```bash
# 1. Create namespace
sudo ip netns add fc-{id}

# 2. Create TAP inside namespace (owned by instance uid)
sudo ip netns exec fc-{id} ip tuntap add name tap0 mode tap user {uid}
sudo ip netns exec fc-{id} ip addr add 172.16.{x}.1/30 dev tap0
sudo ip netns exec fc-{id} ip link set tap0 up

# 3. Create veth pair connecting namespace to host
sudo ip link add veth-{id}-h type veth peer name veth-{id}-g netns fc-{id}

# 4. Configure host side
sudo ip addr add 10.0.{x}.1/30 dev veth-{id}-h
sudo ip link set veth-{id}-h up

# 5. Configure namespace side
sudo ip netns exec fc-{id} ip addr add 10.0.{x}.2/30 dev veth-{id}-g
sudo ip netns exec fc-{id} ip link set veth-{id}-g up
sudo ip netns exec fc-{id} ip route add default via 10.0.{x}.1

# 6. Enable forwarding and NAT on host
sudo iptables -t nat -A POSTROUTING -s 10.0.{x}.2/32 -o {uplink} -j MASQUERADE
sudo iptables -A FORWARD -i veth-{id}-h -o {uplink} -j ACCEPT
sudo iptables -A FORWARD -i {uplink} -o veth-{id}-h -m state --state RELATED,ESTABLISHED -j ACCEPT
```

IP derivation reuses the existing SHA256-based scheme from `TapManager` for deterministic, collision-resistant allocation within the 172.16.0.0/12 (TAP) and 10.0.0.0/16 (veth) ranges.

### Phase 3: Jail Preparation

**New file:** `packages/runtime-firecracker/src/jail.ts`

Handles chroot directory setup before jailer launch.

```ts
interface JailPaths {
  /** Full chroot root: /srv/jailer/firecracker/{id}/root */
  chrootRoot: string;
  /** API socket from host perspective */
  apiSocket: string;
  /** Kernel path relative to chroot root (just "vmlinux") */
  kernelRelative: string;
  /** Rootfs path relative to chroot root (just "rootfs.ext4") */
  rootfsRelative: string;
  /** Log file path (outside chroot, in instance dir) */
  logPath: string;
}

class JailPreparer {
  /**
   * Prepare chroot directory:
   * 1. Ensure /srv/jailer/firecracker/{id}/root/ exists
   * 2. Hard-link (or cp --reflink=auto) kernel into chroot
   * 3. Hard-link (or cp --reflink=auto) rootfs into chroot
   * 4. chown -R uid:gid the chroot root
   * 5. Return paths for jailer and Firecracker config
   */
  async prepare(instanceId: InstanceId, config: {
    kernelPath: string;
    rootfsPath: string;
    uid: number;
    gid: number;
    chrootBaseDir: string;
  }): Promise<JailPaths>;

  /** Remove entire jail directory tree. */
  async cleanup(instanceId: InstanceId, chrootBaseDir: string): Promise<void>;
}
```

### Phase 4: Jailer Process Spawning

**File:** `packages/runtime-firecracker/src/process.ts`

Add `spawnJailer()` alongside existing `spawnFirecracker()`. The existing function stays for non-jailer dev mode.

```ts
interface JailerSpawnOptions {
  jailerId: string;
  execFile: string;         // resolved (readlink -f) path to firecracker binary
  jailerPath: string;
  uid: number;
  gid: number;
  chrootBaseDir: string;
  netnsPath: string;        // /var/run/netns/fc-{id}
  daemonize: boolean;
  newPidNs: boolean;
  cgroupVersion: 1 | 2;
  cgroups?: string[];       // e.g. ["cpuset.cpus=0", "cpuset.mems=0"]
  firecrackerArgs?: string[]; // extra args passed after --
}

function spawnJailer(opts: JailerSpawnOptions): JailedProcess;

interface JailedProcess {
  /** API socket path on host filesystem */
  socketPath: string;
  /** PID file path (inside chroot, readable from host) */
  pidFilePath: string;
  /** Wait for API socket to appear */
  waitForSocket(timeoutMs?: number): Promise<void>;
  /** Kill the Firecracker process (reads PID from file) */
  kill(): Promise<void>;
}
```

The jailer command assembled:

```bash
sudo jailer \
  --id {instanceId} \
  --exec-file {resolvedFirecrackerPath} \
  --uid {uid} \
  --gid {gid} \
  --chroot-base-dir {chrootBaseDir} \
  --netns {nsPath} \
  --daemonize \
  --new-pid-ns \
  --cgroup-version 2 \
  -- \
  --api-sock /run/firecracker.socket
```

Socket path from host: `{chrootBaseDir}/firecracker/{instanceId}/root/run/firecracker.socket`

**Kill semantics:** With `--daemonize`, killing the jailer PID does nothing — Firecracker has already forked. Read the PID from `{chrootRoot}/firecracker.pid` and `kill` directly.

### Phase 5: Runtime Integration

**File:** `packages/runtime-firecracker/src/runtime.ts`

Modify `FirecrackerRuntime` to use jailer when `config.jailer` is set. The key changes:

#### `create()` — before:
1. Create instance dir
2. Create overlay rootfs
3. Create TAP (host-level)
4. `spawnFirecracker()`
5. Configure via API (absolute paths)

#### `create()` — after (jailer mode):
1. Create instance dir (for our bookkeeping, outside jail)
2. Create overlay rootfs (in instance dir)
3. Derive uid from instance ID
4. `netnsManager.create(instanceId)` — namespace + TAP + veth + NAT
5. `jailPreparer.prepare()` — hard-link kernel + rootfs into chroot, chown
6. `spawnJailer()` — launches jailer which execs firecracker
7. Configure via API (**relative** paths: `"vmlinux"`, `"rootfs.ext4"`)

#### `destroy()` — after (jailer mode):
1. Kill Firecracker (via PID file)
2. `netnsManager.destroy()` — removes namespace (TAP + veth auto-cleaned)
3. `jailPreparer.cleanup()` — rm -rf jail directory
4. Remove overlay / instance dir
5. Clean up iptables NAT rules

#### `snapshot()` — after (jailer mode):
1. Pause VM (same as before, via API socket on host)
2. Create snapshot (files written inside chroot)
3. Copy vmstate + memory from `{chrootRoot}/` to `{snapshotDir}/{snapshotId}/`
4. Copy rootfs from instance dir to snapshot dir
5. Resume VM

#### `restore()` — after (jailer mode):
1. Create new instance dir + overlay rootfs (copy from snapshot)
2. Derive new uid, create namespace
3. Prepare new jail (hard-link kernel, copy snapshot rootfs into chroot)
4. Copy vmstate + memory into new chroot
5. Spawn jailer
6. Configure drive + network via API (relative paths)
7. Load snapshot (resume)

#### `getEndpoint()` — after (jailer mode):
- Guest IP comes from `NetnsHandle.guestIp` instead of TAP subnet calculation

### Phase 6: Recovery Updates

**File:** `apps/api/src/recovery.ts`

Update recovery to handle jailer artifacts:

1. List `fc-*` network namespaces via `NetnsManager.list()`
2. Cross-reference with active DB instances
3. Destroy orphaned namespaces
4. Clean up orphaned jail directories in `/srv/jailer/firecracker/`
5. Existing TAP cleanup logic becomes unnecessary (TAPs are inside namespaces now)

### Phase 7: Setup Script

**Replaces:** `scripts/setup-dev.sh`
**New file:** `scripts/setup-firecracker.sh`

One script for both dev and prod, with a `--profile` flag for the differences.

```
Usage: ./scripts/setup-firecracker.sh [--profile dev|prod]

  --profile dev   (default) Current user gets sudoers entry, permissive settings
  --profile prod  Dedicated 'boilerhouse' service user, tighter permissions
```

#### Shared steps (both profiles)

| #  | Step                        | Details                                                                                     | Skip if                          |
|----|-----------------------------|---------------------------------------------------------------------------------------------|----------------------------------|
| 1  | Install Firecracker + jailer | Download release tarball, extract both binaries to `/usr/local/bin/`                       | Both already installed at version |
| 2  | Download guest kernel        | Fetch to `/var/lib/boilerhouse/vmlinux`                                                    | File exists                      |
| 3  | KVM group access             | Add `$SERVICE_USER` to `kvm` group                                                        | Already in group                 |
| 4  | Create jail base dir         | `mkdir -p /srv/jailer` owned by root                                                       | Dir exists                       |
| 5  | Enable IP forwarding         | `sysctl -w net.ipv4.ip_forward=1` + persist to `/etc/sysctl.d/99-boilerhouse.conf`        | Already set                      |
| 6  | Sudoers entry                | `/etc/sudoers.d/boilerhouse` — passwordless sudo for jailer, ip, iptables for `$SERVICE_USER` | File exists with correct content |
| 7  | Subordinate UID range        | Ensure 100000–165535 is available in `/etc/subuid` for `$SERVICE_USER`                     | Already allocated                |
| 8  | Create storage directories   | `/var/lib/boilerhouse/{instances,snapshots,images}` owned by `$SERVICE_USER`               | Dirs exist                       |

#### Dev-only behavior (`--profile dev`, default)

- `$SERVICE_USER` = current user (`$(whoami)`)
- Sudoers entry targets the current user
- Remove old CAP_NET_ADMIN from `ip` binary if present (no longer needed)
- Print reminder to log out/in if group membership changed

#### Prod-only behavior (`--profile prod`)

- Create dedicated `boilerhouse` system user + group if they don't exist
  ```bash
  useradd --system --no-create-home --shell /usr/sbin/nologin boilerhouse
  ```
- `$SERVICE_USER` = `boilerhouse`
- Storage dirs owned by `boilerhouse:boilerhouse`
- Install systemd unit file to `/etc/systemd/system/boilerhouse.service`:
  ```ini
  [Unit]
  Description=Boilerhouse API Server
  After=network.target

  [Service]
  Type=simple
  User=boilerhouse
  Group=boilerhouse
  WorkingDirectory=/opt/boilerhouse
  ExecStart=/usr/local/bin/bun run apps/api/src/server.ts
  Restart=on-failure
  RestartSec=5
  Environment=NODE_ENV=production
  Environment=FIRECRACKER_BIN=/usr/local/bin/firecracker
  Environment=KERNEL_PATH=/var/lib/boilerhouse/vmlinux
  Environment=STORAGE_PATH=/var/lib/boilerhouse
  Environment=JAILER_BIN=/usr/local/bin/jailer
  Environment=JAILER_CHROOT_BASE=/srv/jailer

  [Install]
  WantedBy=multi-user.target
  ```
- `systemctl daemon-reload` (does not enable/start — user does that)

#### Sudoers file (both profiles)

```
# /etc/sudoers.d/boilerhouse
# Allows the boilerhouse service user to manage VMs without interactive password.
{SERVICE_USER} ALL=(root) NOPASSWD: /usr/local/bin/jailer
{SERVICE_USER} ALL=(root) NOPASSWD: /usr/sbin/ip
{SERVICE_USER} ALL=(root) NOPASSWD: /usr/sbin/iptables
```

#### Uninstall / cleanup

Add `scripts/teardown-firecracker.sh` that reverses everything:
1. Remove sudoers file
2. Remove sysctl config, reset ip_forward
3. Remove `/srv/jailer` (if empty or `--force`)
4. Remove binaries from `/usr/local/bin/`
5. Remove kernel from `/var/lib/boilerhouse/`
6. (prod) Remove systemd unit, disable service
7. (prod) Optionally remove `boilerhouse` user

### Phase 8: Integration Tests

**File:** `packages/runtime-firecracker/src/runtime.integration.test.ts`

Add a parallel test suite for jailer mode:

- `describe("FirecrackerRuntime (jailer)")` — mirrors existing tests but with jailer config
- Tests: create, start, stop, destroy, snapshot, restore
- Verify namespace isolation: VM cannot reach host network except through veth
- Verify chroot: Firecracker process cannot see host filesystem
- Verify cleanup: no orphaned namespaces, jails, or cgroup dirs after destroy
- Skip if not root (jailer requires root)

## File Change Summary

| File                                              | Change       |
|---------------------------------------------------|--------------|
| `packages/runtime-firecracker/src/types.ts`       | Add `JailerConfig`, `NetnsHandle` types |
| `packages/runtime-firecracker/src/netns.ts`       | **New** — Network namespace manager |
| `packages/runtime-firecracker/src/jail.ts`        | **New** — Chroot preparation and cleanup |
| `packages/runtime-firecracker/src/process.ts`     | Add `spawnJailer()` alongside existing `spawnFirecracker()` |
| `packages/runtime-firecracker/src/runtime.ts`     | Branch on `config.jailer` for jailer vs direct mode |
| `apps/api/src/server.ts`                          | Wire `JailerConfig` from env vars |
| `apps/api/src/recovery.ts`                        | Add namespace + jail cleanup |
| `apps/api/src/network/tap.ts`                     | Unchanged (still used in non-jailer dev mode) |
| `apps/api/src/network/iptables.ts`                | Move host-level rules to namespace-scoped rules |
| `scripts/setup-firecracker.sh`                    | **New** — Unified setup for dev and prod (`--profile dev\|prod`) |
| `scripts/teardown-firecracker.sh`                 | **New** — Reverse setup (remove sudoers, dirs, binaries) |
| `scripts/setup-dev.sh`                            | **Deleted** — Replaced by `setup-firecracker.sh` |
| `packages/runtime-firecracker/src/runtime.integration.test.ts` | Add jailer test suite |

## Migration Path

1. Jailer mode is opt-in via `config.jailer`. Without it, everything works as before.
2. Dev environments can keep using direct spawn (no root needed, no isolation).
3. Production and staging use jailer mode.
4. The old `TapManager` + host-level iptables path remains for backwards compatibility until jailer mode is validated.

## Open Questions

- **Cgroup v1 vs v2:** Need to detect which the host uses. Most modern distros (Ubuntu 22.04+) default to v2. The jailer supports both via `--cgroup-version`.
- **OverlayFS for rootfs:** Currently using `cp --reflink=auto`. For high-density deployments, OverlayFS mounts would save significant disk space. This is orthogonal to the jailer work but worth noting.
- **CNI plugins:** The manual veth+NAT approach works but CNI (specifically `tc-redirect-tap`) is the more standard Firecracker networking solution. Could adopt later without changing the jailer integration.
