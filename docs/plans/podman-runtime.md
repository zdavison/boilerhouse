# Podman Runtime

## Motivation

Podman gives us OCI container execution with CRIU-based checkpoint/restore. It implements the
`Runtime` interface with full snapshot semantics, no kernel images or `/dev/kvm` required.
Podman has first-class CRIU integration (`podman container checkpoint/restore`) making
snapshot/restore reliable and production-grade — especially on RHEL/Fedora where Red Hat
invests heavily in this stack.

## Design

### What Podman provides

| Concern               | Podman                                             |
|-----------------------|----------------------------------------------------|
| Isolation             | Container (namespaces + cgroups)                   |
| Image format          | OCI image pulled via `podman pull`                 |
| Networking            | Podman bridge / slirp4netns, published ports       |
| Snapshot              | CRIU checkpoint archive (`.tar.gz`)                |
| Restore               | `podman container restore --import <archive>`      |
| Startup               | `podman run` (cold boot)                           |
| Stop                  | `podman stop`                                      |
| Destroy               | `podman rm -f`                                     |
| Exec                  | `podman exec`                                      |
| Endpoint              | `localhost` + published host port                  |
| Availability check    | `podman info` succeeds + CRIU available            |

### What doesn't change

- The `Runtime` interface signature — Podman implements all 10 methods
- The API routes, the DB schema, the event bus
- Workload TOML format — `image.ref` already maps naturally to an OCI image ref

### What DOES change in the API layer

The current `TenantManager`, `InstanceManager`, and `SnapshotManager` assume all runtimes
have the same capabilities. With multiple runtimes, some capabilities may differ. This
requires changes at the manager level — not just the runtime.

---

## CRIU checkpoint/restore: how it works

CRIU (Checkpoint/Restore in Userspace) freezes a running process tree and saves its full
state to disk: memory pages, CPU registers, open file descriptors, network sockets, and
pending signals. Podman wraps CRIU behind a simple CLI.

### Checkpoint (snapshot)

```bash
podman container checkpoint <container> --export /path/to/checkpoint.tar.gz
```

The exported archive contains:
- **CRIU image files** — process memory, CPU state, file descriptors, signal state
- **Rootfs diff layer** — filesystem changes since the container was created
- **Container config** — environment, mounts, networking config, image ref

After checkpoint, the container is stopped (state is fully captured).

### Restore

```bash
podman container restore --import /path/to/checkpoint.tar.gz --name <new-name>
```

This creates a new container and resumes execution from exactly where the checkpoint
was taken. The process continues as if nothing happened — same PID namespace, same
memory layout, same open files.

### CRIU snapshot characteristics

| Aspect              | Podman + CRIU                         |
|---------------------|---------------------------------------|
| Scope               | Process tree (userspace only)         |
| Output format       | Single `.tar.gz` archive              |
| Restore target      | Same image + CRIU version recommended |
| Network state       | TCP sockets may break on restore      |
| Restore latency     | ~200-500ms                            |
| Rootfs handling     | Included in checkpoint archive        |
| Host requirements   | CRIU >= 3.15 + rootful Podman         |

### Mapping to `SnapshotPaths`

Podman produces a single archive file, but `SnapshotPaths` has two fields (`memory` and
`vmstate`). Since these paths are opaque to everything except the runtime that creates
and consumes them, we store the archive path in both fields:

```ts
const paths: SnapshotPaths = {
  memory: "/snapshots/<id>/checkpoint.tar.gz",
  vmstate: "/snapshots/<id>/checkpoint.tar.gz",
};
```

Both fields point to the same file. The runtime knows to treat this as a single archive.
This avoids changing the core `SnapshotPaths` type while keeping DB storage consistent.

### Mapping to `SnapshotMetadata`

```ts
const runtimeMeta: SnapshotMetadata = {
  runtimeVersion: "5.4.2",       // podman version
  architecture: "x86_64",        // uname -m
};
```

---

## Snapshot capability and its ripple effects

### The problem

Even though Podman supports checkpoint/restore, the capability system is still valuable.
Future runtimes may not support snapshots, and the cold-boot fallback path is useful
when no golden snapshot exists yet (currently throws `NoGoldenSnapshotError`).

### The solution: `Runtime.capabilities`

Add a capabilities set to the `Runtime` interface, so optional capabilities can be
added without changing the interface shape:

```ts
/** Capabilities that a runtime may or may not support. */
export type RuntimeCapability = "snapshot" | "exec";

export interface Runtime {
  /** The set of optional capabilities this runtime supports. */
  readonly capabilities: ReadonlySet<RuntimeCapability>;

  // ... existing methods unchanged
}
```

Per-runtime capabilities:

| Capability   | Podman | FakeRuntime                |
|--------------|--------|----------------------------|
| `"snapshot"` | yes    | configurable (default yes) |
| `"exec"`     | yes    | configurable (default yes) |

Convenience helper in `packages/core/src/runtime.ts`:

```ts
export function runtimeSupports(
  runtime: Runtime,
  capability: RuntimeCapability,
): boolean {
  return runtime.capabilities.has(capability);
}
```

Managers call `runtimeSupports(this.runtime, "snapshot")` to branch on capability.
Using a set of enums means future capabilities (e.g. `"resize"`, `"migrate"`) can be
added by extending the `RuntimeCapability` union — no new properties needed.

### Manager changes required

Even with Podman supporting snapshots, these changes are needed for robustness and
for any future runtime that lacks snapshot support.

#### `TenantManager.claim()` — add cold-boot fallback

```
TenantManager.claim()
  1. existing active instance?     → return it
  if (runtimeSupports(runtime, "snapshot")):
    2. tenant snapshot?            → restoreFromSnapshot()
    3. golden + data overlay?      → restoreFromSnapshot(golden)
    4. golden snapshot?            → restoreFromSnapshot(golden)
  5. cold boot                     → instanceManager.create(workloadId, workload)
```

A new `ClaimSource` value: `"cold"`. The cold-boot path loads the workload config from
the DB and calls `instanceManager.create()`, which does `runtime.create()` + `runtime.start()`.

Step 5 is reachable as a fallback if no golden snapshot exists yet (e.g. first boot of
a new workload before `createGolden` has been called). This is an improvement over the
current behaviour, which throws `NoGoldenSnapshotError`.

#### `TenantManager.release()` — force destroy when snapshots unsupported

```ts
const action = runtimeSupports(this.runtime, "snapshot")
  ? (idleAction ?? "hibernate")
  : "destroy";
```

If the runtime doesn't support snapshots, always destroy on release regardless of the
workload's `idle.action` setting.

#### `InstanceManager.hibernate()` — fail fast

Check capabilities before attempting the snapshot:

```ts
if (!runtimeSupports(this.runtime, "snapshot")) {
  throw new Error("Cannot hibernate: runtime does not support snapshots");
}
```

#### `SnapshotManager.createGolden()` — fail fast

Same pattern:

```ts
if (!runtimeSupports(this.runtime, "snapshot")) {
  throw new Error("Cannot create golden snapshot: runtime does not support snapshots");
}
```

#### Dashboard — surface capabilities

The API already exposes the node's `runtimeType`. The dashboard should use this to
surface capability differences if needed. A `GET /api/v1/system/capabilities` endpoint
can expose the runtime's capability set.

#### Instance state machine — no changes needed

The machine itself doesn't need to know about runtime capabilities. The managers
check `runtimeSupports(runtime, "snapshot")` **before** attempting a state transition.
If they never send the `hibernate` event, the machine never reaches `hibernated`. The
guard lives in the manager, not the FSM.

## Implementation

### Package: `packages/runtime-podman/`

```
packages/runtime-podman/
├── package.json
├── tsconfig.json
└── src/
    ├── index.ts                    # re-exports
    ├── runtime.ts                  # PodmanRuntime implements Runtime
    ├── runtime.integration.test.ts
    ├── types.ts                    # PodmanConfig, ManagedContainer
    └── errors.ts                   # PodmanRuntimeError
```

### Types (`types.ts`)

```ts
export interface PodmanConfig {
  /** Node ID for this runtime instance. */
  nodeId: NodeId;
  /**
   * Directory for storing checkpoint archives.
   * @default "/var/lib/boilerhouse/snapshots"
   */
  snapshotDir?: string;
  /**
   * Network to attach containers to.
   * @default "bridge"
   */
  network?: string;
  /** Resource limit overrides. */
  resourceDefaults?: {
    /** @default 1 */
    vcpus?: number;
    /** @default 256 */
    memoryMb?: number;
  };
}

export interface ManagedContainer {
  instanceId: InstanceId;
  workloadId: WorkloadId;
  running: boolean;
}
```

### Runtime (`runtime.ts`)

```ts
export class PodmanRuntime implements Runtime {
  readonly capabilities = new Set<RuntimeCapability>(["snapshot", "exec"]);

  private readonly containers = new Map<string, ManagedContainer>();
  private readonly config: Required<PodmanConfig>;

  constructor(config: PodmanConfig);

  // ── Lifecycle ──────────────────────────

  async create(workload: Workload, instanceId: InstanceId): Promise<InstanceHandle>;
  // 1. podman pull <image.ref> (skip if already present)
  // 2. podman create with:
  //    --name <instanceId>
  //    --cpus <workload.resources.vcpus>
  //    --memory <workload.resources.memory_mb>m
  //    -p 0:<guest-port>   (let Podman pick host port)
  //    --network <config.network>
  //    env vars from workload.entrypoint.env
  //    entrypoint/cmd from workload.entrypoint
  // 3. Track in containers map
  // 4. Return { instanceId, running: false }

  async start(handle: InstanceHandle): Promise<void>;
  // podman start <instanceId>

  async stop(handle: InstanceHandle): Promise<void>;
  // podman stop <instanceId> (graceful, SIGTERM + timeout)

  async destroy(handle: InstanceHandle): Promise<void>;
  // podman rm -f <instanceId> (force remove, best-effort)
  // Remove from containers map

  // ── Snapshot (CRIU) ────────────────────

  async snapshot(handle: InstanceHandle): Promise<SnapshotRef>;
  // 1. Generate snapshot ID
  // 2. podman container checkpoint <instanceId> \
  //      --export <snapshotDir>/<snapshotId>/checkpoint.tar.gz
  // 3. Get podman version for runtimeMeta
  // 4. Return SnapshotRef with paths pointing to the archive

  async restore(ref: SnapshotRef, instanceId: InstanceId): Promise<InstanceHandle>;
  // 1. podman container restore \
  //      --import <ref.paths.vmstate> \
  //      --name <instanceId>
  // 2. Track in containers map
  // 3. Return { instanceId, running: true }

  // ── Exec ───────────────────────────────

  async exec(handle: InstanceHandle, command: string[]): Promise<ExecResult>;
  // podman exec <instanceId> <command...>
  // Parse stdout, stderr, exit code from result

  // ── Networking ─────────────────────────

  async getEndpoint(handle: InstanceHandle): Promise<Endpoint>;
  // podman inspect to get published host port
  // Return { host: "127.0.0.1", port: <published-host-port> }

  // ── Discovery ──────────────────────────

  async list(): Promise<InstanceId[]>;
  // Return keys from containers map

  async available(): Promise<boolean>;
  // 1. podman info — return false if exit code != 0
  // 2. Check CRIU availability: podman info --format '{{.Host.CriuEnabled}}'
  //    (or criu --version) — warn if not available
}
```

### How Podman commands are executed

Use `Bun.spawn()` to shell out to the `podman` CLI. This keeps the implementation
simple and dependency-free.

Helper function:

```ts
async function podman(
  ...args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["podman", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}
```

### Port mapping strategy

The workload's `network.expose` array defines guest ports. Podman's `-p 0:<guest>` lets
the OS pick a free host port. After `podman start`, `podman inspect --format` retrieves
the assigned port.

If no `network.expose` is defined, default to exposing container port 8080.

### Container naming

Containers are named by their `instanceId` (a UUID). This gives us:
- Uniqueness guarantee
- Easy correlation between DB records and Podman containers
- Simple `podman inspect <instanceId>` lookups

### Networking modes

The workload `network.access` field maps to Podman networking:

| `network.access` | Podman behaviour                                          |
|-------------------|-----------------------------------------------------------|
| `"none"`          | `--network none` (no external access)                     |
| `"outbound"`      | Default bridge (full outbound access)                     |
| `"restricted"`    | Default bridge (allowlisting left to external firewall)   |

The `allowlist` field is not enforced at the Podman level — Podman doesn't have built-in
domain-based allowlisting. Document this as a known limitation.

### Resource mapping

| Workload field            | Podman flag                         |
|---------------------------|-------------------------------------|
| `resources.vcpus`         | `--cpus <n>`                        |
| `resources.memory_mb`     | `--memory <n>m`                     |
| `resources.disk_gb`       | Not directly mapped (Podman default)|
| `entrypoint.cmd`          | `--entrypoint <cmd>`                |
| `entrypoint.args`         | Appended after image ref            |
| `entrypoint.env`          | `-e KEY=VALUE` for each entry       |

### Error handling (`errors.ts`)

```ts
export class PodmanRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PodmanRuntimeError";
  }
}
```

Thrown when:
- `podman` CLI returns non-zero exit code
- CRIU checkpoint/restore fails
- Container not found in the internal map

### Core type changes

`"podman"` is already in the `RuntimeType` union in `packages/core/src/node.ts`.

## Phase plan

### Phase 1: Add `capabilities` to the Runtime interface
1. Add `RuntimeCapability` type and `readonly capabilities: ReadonlySet<RuntimeCapability>` to `packages/core/src/runtime.ts`
2. Add `runtimeSupports()` helper function
3. Add `capabilities` to `FakeRuntimeOptions` (default `new Set(["snapshot", "exec"])` for backwards compat)
4. Update `FakeRuntime` to expose the configurable set
5. Update existing tests if needed (all should pass — defaults match current behaviour)

### Phase 2: Adapt managers for snapshot-optional runtimes (TDD)
1. **`InstanceManager.hibernate()`** — add early `runtimeSupports(runtime, "snapshot")` check, throw before attempting snapshot
2. **`SnapshotManager.createGolden()`** — add early capability check
3. **`TenantManager.claim()`** — add cold-boot fallback path (new `"cold"` source)
   - When runtime lacks `"snapshot"`, skip snapshot hierarchy entirely
   - When runtime has `"snapshot"` but no golden exists, fall back to cold boot instead of throwing
4. **`TenantManager.release()`** — force `"destroy"` when runtime lacks `"snapshot"`
5. Write tests with `FakeRuntime({ capabilities: new Set() })` to verify all four paths
6. Route error handling: `POST /instances/:id/hibernate` returns 409 when `"snapshot"` unsupported

### Phase 3: Package scaffold
1. Create `packages/runtime-podman/` with `package.json`, `tsconfig.json`
2. Add `errors.ts` and `types.ts`
3. Wire up workspace dependency in root `package.json`

### Phase 4: Implement `PodmanRuntime` (TDD)
1. Write integration tests (`runtime.integration.test.ts`)
2. Implement `available()` — verify Podman + CRIU are accessible
3. Implement `create()` + `start()` — pull image, create container, start
4. Implement `getEndpoint()` — inspect for published port
5. Implement `stop()` — graceful stop
6. Implement `destroy()` — force remove + cleanup
7. Implement `exec()` — run command inside container
8. Implement `snapshot()` — CRIU checkpoint + export archive
9. Implement `restore()` — import archive + resume container
10. Implement `list()` — return tracked instance IDs

### Phase 5: Wire into API server
1. Server startup reads node `runtimeType` and instantiates the matching runtime
2. No route changes needed — `RouteDeps.runtime` is already `Runtime` (interface), managers
   already branch on capabilities
3. End-to-end test: register a Podman workload, claim a tenant, create golden snapshot,
   restore from snapshot, release with hibernate, restore from tenant snapshot

## Considerations

### Host requirements

CRIU checkpoint/restore requires:
- **Rootful Podman** — rootless Podman has significant CRIU limitations (user namespace
  restore issues, network namespace constraints)
- **CRIU >= 3.15** — earlier versions have bugs with container restore
- **Kernel support** — most modern kernels (5.x+) work; CRIU uses `/proc/pid/map_files`,
  `PTRACE_SEIZE`, and other kernel facilities
- **Best on RHEL/Fedora** — Red Hat actively maintains and tests this stack

The `available()` method checks for both Podman and CRIU presence, returning `false` if
either is missing.

### TCP connections on restore

CRIU can restore TCP sockets, but connections to external hosts will have timed out
during the checkpoint period. Applications should handle reconnection gracefully.

For workloads that serve HTTP (stateless request/response), this is a non-issue — the
listening socket is restored and new connections work immediately.

### Image pulling

`podman pull` on first `create()` can be slow. Options:
- **Eager pull**: fail fast if image isn't present, require pre-pulling — keeps `create()` fast
- **Lazy pull**: pull on demand during `create()` — simpler but first boot is slower

Start with lazy pull (pull on demand). Add an optional pre-pull/warm-up mechanism later
if startup latency matters.

### Checkpoint archive size

CRIU checkpoint archives include the full process memory. For a container using 256 MB
of RAM, expect ~256 MB archives (plus rootfs diff).

The `snapshotDir` config controls where archives are stored.

### Reconciliation on restart

If the API server restarts, the in-memory `containers` map is lost but Podman containers
may still be running. Two options:
- **Ignore for now**: the `recovery.ts` module already handles this case
- **Later**: Add a `reconcile()` method that lists containers with a known label and rebuilds the map

### Why Podman over Docker?

- **First-class CRIU support** — `podman container checkpoint/restore` is production-grade,
  not hidden behind `--experimental`
- **Daemonless** — no long-running daemon; each `podman` command is a direct process
- **Rootless option** — for non-snapshot workloads, rootless Podman provides better
  security isolation (CRIU snapshots still need rootful)
- **OCI-compatible** — uses the same images, registries, and container standards as Docker
- **Red Hat investment** — actively maintained, tested on enterprise Linux, CRIU integration
  is a strategic priority
- **CLI-compatible** — `podman` is a drop-in replacement for `docker` CLI syntax

### Why not the Podman API directly?

Shelling out to the `podman` CLI is simpler, has no dependencies, and uses `Bun.spawn()`
for process management. The Podman CLI handles auth,
TLS, and socket communication. If performance becomes an issue, we can switch to the
Podman REST API later without changing the `Runtime` interface contract.
