# Docker Runtime — Replace Podman + boilerhoused

## Motivation

CRIU checkpoint/restore was removed in the hot-pooling migration (PR #23). Without CRIU:

- **Rootful Podman is unnecessary** — CRIU was the only reason we needed root.
- **`boilerhoused` is unnecessary** — it existed solely to confine root to a narrow daemon. With rootless containers there's nothing to isolate.
- **The `available()` check is wrong** — `PodmanRuntime.available()` returns false if `criuEnabled` is false, which gates the entire runtime on a feature we no longer use.

Docker is a simpler replacement: its socket (`/var/run/docker.sock`) is accessible to the `docker` group with no root required, its API is stable and well-documented, and it removes the need for both the Podman-specific libpod client and the privilege-separating daemon.

---

## What Gets Removed

| Artifact | Reason |
|---|---|
| `apps/boilerhouse-podmand/` | Entire app deleted — privilege separation no longer needed |
| `packages/runtime-podman/` | Entire package deleted — replaced by `runtime-docker` |
| `apps/cli/src/embedded/podmand.service.ts` | Systemd service for the daemon |
| `apps/cli/src/commands/host-install.ts` | Podmand install logic |
| `scripts/setup-boilerhouse-podmand.sh` | Rootful Podman + CRIU setup script |
| `scripts/start-boilerhouse-podmand.sh` | Daemon start script |
| `tests/integration/podman.integration.test.ts` | Podmand-specific integration tests |
| `BOILERHOUSE_CRIU_AVAILABLE` env var | No longer meaningful |
| `RUNTIME_SOCKET` env var | No longer needed (Docker socket path is standard) |
| `SNAPSHOT_DIR` / `snapshotDir` config | No snapshots to store |
| `BOILERHOUSE_ENCRYPTION_KEY` | No archives to encrypt |

---

## New Package: `packages/runtime-docker/`

### Architecture

The Docker runtime talks directly to the Docker socket (`/var/run/docker.sock`) with no intermediate daemon. This is safe because Docker's socket is owned by the `docker` group — no root required.

```
API Server (docker group)
        │
        │ HTTP/Unix socket  (/var/run/docker.sock)
        ▼
Docker Engine
```

### Module structure

```
packages/runtime-docker/
  src/
    runtime.ts        # DockerRuntime implements Runtime
    client.ts         # Thin HTTP-over-socket Docker API client
    hardening.ts      # Capability constants (same as runtime-podman/hardening.ts)
    errors.ts
    types.ts          # DockerConfig
    index.ts
  package.json
```

### DockerRuntime design

**Implements:** `create`, `start`, `destroy`, `exec`, `getEndpoint`, `list`, `logs`, `available`

**`available()`** — `GET /_ping` on the Docker socket. Returns true if Docker responds.

**`create(workload, instanceId, options?)`**

1. Ensure image (pull if registry ref, build if Dockerfile).
2. Create workload container with:
   - Name: `instanceId`
   - Labels: `boilerhouse.managed=true`, `boilerhouse.workload`, `boilerhouse.version`
   - Port bindings: `{ "8080/tcp": [{ HostPort: "0" }] }` (ephemeral host port)
   - Resource limits: CPU quota/period, memory limit, storage-opt size
   - Security: `CapDrop: ["ALL"]`, `CapAdd: HARDENED_CAP_ADD`, `SecurityOpt: ["no-new-privileges:true"]`, optional seccomp
   - `PidMode: "private"`
3. If `proxyConfig` provided:
   - Write Envoy config to a temp file
   - Create Envoy sidecar container with:
     - `NetworkMode: "container:<workload-container-id>"` (shares workload's network namespace)
     - Bind-mount the config file read-only at `/etc/envoy/envoy.yaml`
     - `CapDrop: ["ALL"]`, `no-new-privileges`
   - Inject `HTTP_PROXY=http://localhost:18080` into workload container env

**`start(handle)`** — `POST /containers/{id}/start` on workload container, then sidecar if present.

**`destroy(handle)`** — Stop + remove sidecar (if any), then workload container. Remove config file if written.

**`getEndpoint(handle)`** — `GET /containers/{id}/json`, read `NetworkSettings.Ports` from workload container.

**`exec(handle, command)`** — `POST /containers/{id}/exec` → `POST /exec/{id}/start` with demux.

**`logs(handle, tail)`** — `GET /containers/{id}/logs?tail={n}&stdout=1&stderr=1`.

**`list()`** — `GET /containers/json?filters={"label":["boilerhouse.managed=true"]}`, return names.

### Docker API client

Thin HTTP-over-socket client, same pattern as `PodmanClient` but against Docker's Engine API (`/v1.47/*`). No external dependencies.

Key endpoints:

| Operation | Docker endpoint |
|---|---|
| Ping | `GET /_ping` |
| Pull image | `POST /images/create?fromImage={ref}` |
| Image exists | `GET /images/{name}/json` |
| Build image | `POST /build` (multipart tar) |
| Create container | `POST /containers/create` |
| Start container | `POST /containers/{id}/start` |
| Stop container | `POST /containers/{id}/stop` |
| Remove container | `DELETE /containers/{id}?force=true` |
| Inspect container | `GET /containers/{id}/json` |
| Exec create | `POST /containers/{id}/exec` |
| Exec start | `POST /exec/{id}/start` |
| Logs | `GET /containers/{id}/logs` |
| List containers | `GET /containers/json` |

### Envoy sidecar: network namespace sharing

In Podman, containers inside a pod share a network namespace via the infra container. Docker's equivalent is `NetworkMode: "container:<id>"`. The sidecar joins the workload container's exact network namespace, so:

- Sidecar binds `0.0.0.0:18080` — appears on the same localhost as the workload
- `HTTP_PROXY=http://localhost:18080` routes outbound HTTP through Envoy
- Port bindings belong to the workload container (the sidecar inherits them but doesn't re-declare)

This is identical in behaviour to the Podman pod approach.

### Security hardening

Same capability set as `packages/runtime-podman/src/hardening.ts`:

```
DROP ALL
ADD: CHOWN, DAC_OVERRIDE, FOWNER, FSETID, KILL, SETGID, SETUID, NET_BIND_SERVICE
SecurityOpt: no-new-privileges:true
PidMode: private
```

Optional seccomp via `SECCOMP_PROFILE_PATH` env var (same as before).

### overlay_dirs

The workload's `filesystem.overlay_dirs` can continue to be mounted as tmpfs — it's a valid choice for writable ephemeral directories regardless of CRIU. Remove the "so CRIU can checkpoint inode handles" comment.

---

## Migration Steps

### Step 1 — Create `packages/runtime-docker/`

New package from scratch. Implement `DockerRuntime` as described above. Unit-test the client with a mock socket (same pattern as `runtime-podman` client tests).

### Step 2 — Update `apps/api/src/server.ts`

- Add `RUNTIME_TYPE=docker` as the new default (replacing `podman`)
- Import `DockerRuntime` from `@boilerhouse/runtime-docker`
- Remove `snapshotDir` creation and `SNAPSHOT_DIR` / `BOILERHOUSE_ENCRYPTION_KEY` env vars
- Remove `socketPath` / `RUNTIME_SOCKET` env var
- Optionally accept `DOCKER_SOCKET` env var for non-standard socket paths

```typescript
// Before
runtime = new PodmanRuntime({ snapshotDir, socketPath });

// After
runtime = new DockerRuntime({
  socketPath: process.env.DOCKER_SOCKET ?? "/var/run/docker.sock",
  seccompProfilePath: process.env.SECCOMP_PROFILE_PATH,
});
```

### Step 3 — Update `packages/core/src/runtime.ts`

The `RuntimeType` union probably includes `"podman"` — update to `"docker"`. If `snapshotDir` appears in any core types, remove it.

### Step 4 — Delete removed artifacts

- `apps/boilerhouse-podmand/`
- `packages/runtime-podman/`
- `apps/cli/src/embedded/podmand.service.ts`
- Setup/start scripts for podmand
- `tests/integration/podman.integration.test.ts`

### Step 5 — Update CLI (`apps/cli/`)

- Remove `host-install` command or replace with Docker socket permission setup instructions
- Remove any podmand service lifecycle commands

### Step 6 — Update integration/e2e tests

- Add `tests/integration/docker.integration.test.ts` (mirrors the old podman one)
- Update `tests/e2e/runtime-matrix.ts`: replace `podman` runtime with `docker`
- Update `BOILERHOUSE_E2E_RUNTIMES` documentation
- Remove `BOILERHOUSE_CRIU_AVAILABLE` from all test invocations

### Step 7 — Update CLAUDE.md and docs

- Replace podmand setup instructions with "add user to docker group"
- Remove CRIU version requirements

---

## Kubernetes Runtime — Simplification

The Kubernetes runtime has no CRIU code (it was never implemented there), but it has two stale artifacts:

### 1. Dead field: `ManagedPod.workload`

```typescript
// runtime.ts:21-27
/**
 * Tracks a managed pod and its associated workload (needed for restore).
 */
interface ManagedPod {
    workload: Workload;  // ← stored but never read back
    ...
}
```

The `workload` field is stored in `create()` but is never accessed again on the `ManagedPod` struct — it was preserved for a restore path that was never built. Remove the field and the comment.

### 2. Stale config fields passed from server.ts

`server.ts` passes `snapshotDir` and `encryptionKey` to `KubernetesRuntime` via the `common` spread, but `KubernetesConfig` doesn't declare these fields — they're silently ignored. Clean up `server.ts` to not pass them, and verify `KubernetesConfig` has no stale snapshot-related fields.

### 3. No structural changes needed

Everything else in the Kubernetes runtime is clean and functional. The port-forwarding complexity is real (minikube docker driver doesn't route pod IPs to the host). Keep as-is.

---

## What Stays

- Envoy proxy sidecar pattern (independent of CRIU)
- Security hardening (capabilities, seccomp, pid namespace, resource limits)
- Kubernetes runtime (minimal cleanup only)
- FakeRuntime (unchanged)
- All observability / tracing instrumentation

---

## Environment Variable Changes

| Old | New | Note |
|---|---|---|
| `RUNTIME_TYPE=podman` | `RUNTIME_TYPE=docker` | New default |
| `RUNTIME_SOCKET` | (removed) | Docker socket path is standard |
| `SNAPSHOT_DIR` | (removed) | No snapshots |
| `BOILERHOUSE_ENCRYPTION_KEY` | (removed) | No archives |
| `BOILERHOUSE_CRIU_AVAILABLE` | (removed) | No CRIU |
| — | `DOCKER_SOCKET` | Optional override, default `/var/run/docker.sock` |
| — | `SECCOMP_PROFILE_PATH` | Optional seccomp profile |
