# Podman Runtime

## Motivation

Podman gives us OCI container execution with CRIU-based checkpoint/restore. It implements the
`Runtime` interface with full snapshot semantics, no kernel images or `/dev/kvm` required.
Podman has first-class CRIU integration (`podman container checkpoint/restore`) making
snapshot/restore reliable and production-grade — especially on RHEL/Fedora where Red Hat
invests heavily in this stack.

## Architecture: Socket-Based Privilege Boundary

CRIU checkpoint/restore requires rootful podman. The API server runs as an unprivileged user.
A Unix socket provides the privilege boundary between them.

```
API Server (userspace)
  └─ PodmanRuntime
       └─ PodmanClient (HTTP over Unix socket)
            └─ /run/boilerhouse/podman.sock
                 └─ podman system service (rootful, systemd)
```

### Why a socket instead of shelling out?

- **Privilege separation** — the API server never needs root. The rootful podman daemon
  runs as a systemd service. The socket has `660` permissions with the API server's group.
- **No `sudo` in code** — `Bun.spawn(["sudo", "podman", ...])` is fragile (requires NOPASSWD),
  hard to audit, and breaks in containers.
- **Production-grade** — `podman system service` is maintained by Red Hat and exposes the
  full Libpod REST API. No custom daemon code needed.
- **Checkpoint streaming** — the checkpoint API streams the tar.gz archive as the HTTP
  response body. The API server writes it to disk. Files are owned by the API server user —
  no permission issues with `statSync()` in SnapshotManager. For restore, the API server
  reads the archive and POSTs it as the request body.

## Libpod API Endpoint Mapping

| Runtime method  | HTTP endpoint                                                                    |
|-----------------|----------------------------------------------------------------------------------|
| `available()`   | `GET /libpod/info`                                                               |
| `create()`      | `POST /libpod/images/pull` + `POST /libpod/containers/create`                    |
| `start()`       | `POST /libpod/containers/{id}/start`                                             |
| `destroy()`     | `DELETE /libpod/containers/{id}?force=true`                                      |
| `snapshot()`    | `POST /libpod/containers/{id}/checkpoint?export=true&leaveRunning=false`         |
| `restore()`     | `POST /libpod/containers/restore?import=true&name={newId}`                       |
| `exec()`        | `POST /libpod/containers/{id}/exec` + `POST /libpod/exec/{id}/start`            |
| `getEndpoint()` | `GET /libpod/containers/{id}/json` → parse `NetworkSettings.Ports`               |
| `list()`        | In-memory map (unchanged)                                                        |

## PodmanClient

`packages/runtime-podman/src/client.ts` — HTTP client using `node:http` with `socketPath`.

Key design decisions:
- **`checkpointContainer()`** returns the archive as a `Buffer`. The runtime writes it to disk.
- **`restoreContainer()`** accepts a `Buffer` and the new container name. The runtime reads from disk.
- **`execStart()`** demultiplexes the Docker/Podman stream format (8-byte header per frame).
- **Error handling** — all methods throw `PodmanRuntimeError` on failure.

## CRIU Checkpoint/Restore

### Checkpoint (snapshot)

```bash
# CLI equivalent of what the API does:
podman container checkpoint <container> --export /path/to/checkpoint.tar.gz
```

The exported archive contains:
- **CRIU image files** — process memory, CPU state, file descriptors, signal state
- **Rootfs diff layer** — filesystem changes since the container was created
- **Container config** — environment, mounts, networking config, image ref

After checkpoint, the container is stopped (state is fully captured).

### Restore

```bash
# CLI equivalent:
podman container restore --import /path/to/checkpoint.tar.gz --name <new-name>
```

Creates a new container and resumes execution from exactly where the checkpoint was taken.

### Mapping to `SnapshotPaths`

Podman produces a single archive file, but `SnapshotPaths` has two fields. Both point to
the same file:

```ts
const paths: SnapshotPaths = {
  memory: "/snapshots/<id>/checkpoint.tar.gz",
  vmstate: "/snapshots/<id>/checkpoint.tar.gz",
};
```

### Mapping to `SnapshotMetadata`

```ts
const runtimeMeta: SnapshotMetadata = {
  runtimeVersion: "5.4.2",       // from GET /libpod/info
  architecture: "x86_64",        // from uname -m
};
```

## Daemon Setup

### Production (systemd)

Install `deploy/boilerhouse-podman.service`:

```bash
sudo cp deploy/boilerhouse-podman.service /etc/systemd/system/boilerhouse-podman@.service
sudo systemctl daemon-reload
sudo systemctl enable --now boilerhouse-podman@<group>.service
```

Where `<group>` is the group the API server runs as (e.g. `boilerhouse`).

### Development

```bash
sudo scripts/start-podman-daemon.sh
```

Creates the socket at `/run/boilerhouse/podman.sock` with `660` permissions accessible
to the current user's group.

## Configuration

| Variable        | Description                              | Default                          |
|-----------------|------------------------------------------|----------------------------------|
| `PODMAN_SOCKET` | Path to the rootful podman API socket    | `/run/boilerhouse/podman.sock`   |
| `SNAPSHOT_DIR`  | Directory for checkpoint archives        | `/var/lib/boilerhouse/snapshots` |

## Host Requirements

- **Rootful Podman** — rootless Podman does not support CRIU checkpoint/restore
- **CRIU >= 3.15** — earlier versions have bugs with container restore
- **Kernel 5.x+** — CRIU uses `/proc/pid/map_files`, `PTRACE_SEIZE`, etc.
- **Best on RHEL/Fedora** — Red Hat actively maintains and tests this stack

## Considerations

### TCP connections on restore

CRIU can restore TCP sockets, but connections to external hosts will have timed out.
Applications should handle reconnection gracefully. For HTTP workloads (stateless
request/response), the listening socket is restored and new connections work immediately.

### Checkpoint archive size

CRIU checkpoint archives include the full process memory. For a container using 256 MB
of RAM, expect ~256 MB archives (plus rootfs diff).

### Reconciliation on restart

If the API server restarts, the in-memory `containers` map is lost but Podman containers
may still be running. The `recovery.ts` module handles this case.

### Image pulling

`pullImage()` is lazy — pulls on demand during `create()`. First boot of a workload may
be slow if the image isn't cached.
