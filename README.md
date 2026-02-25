# Boilerhouse

NOT-RELEASED

Boilerhouse is a multi-tenant container orchestration platform that uses CRIU checkpoint/restore
to provide instant, fork-style tenant provisioning from golden snapshots.

## Prerequisites

- [Bun](https://bun.sh) >= 1.3
- [Podman](https://podman.io) >= 5.0
- [CRIU](https://criu.org) >= 4.0

## Setup

### 1. Install system dependencies

#### Ubuntu / Debian

```bash
sudo apt-get update
sudo apt-get install -y podman criu
```

#### Fedora / RHEL

```bash
sudo dnf install -y podman criu
```

### 2. Verify installation

```bash
podman --version          # should print >= 5.0
podman info --format '{{.Host.CriuEnabled}}'  # should print "true"
```

If CRIU shows as disabled, check that:
- The `criu` binary is installed and on `$PATH`
- You're running podman as root (rootful mode) — rootless podman does not support CRIU

### 3. Start the rootful podman daemon

CRIU checkpoint/restore requires rootful podman. The API server communicates with rootful
podman over a Unix socket at `/run/boilerhouse/podman.sock`.

**Development:**

```bash
sudo scripts/start-podman-daemon.sh
```

**Production (systemd):**

```bash
# Install the service (replace <group> with the API server's group)
sudo cp deploy/boilerhouse-podman.service /etc/systemd/system/boilerhouse-podman@.service
sudo systemctl daemon-reload
sudo systemctl enable --now boilerhouse-podman@<group>.service
```

**Verify the socket is working:**

```bash
curl --unix-socket /run/boilerhouse/podman.sock http://localhost/v5.0.0/libpod/info | jq .host.criuEnabled
```

### 4. Install project dependencies

```bash
bun install
```

### 5. Create data directories

```bash
sudo mkdir -p /var/lib/boilerhouse/snapshots
sudo mkdir -p /var/lib/boilerhouse/data
sudo chown -R $(whoami):$(whoami) /var/lib/boilerhouse
```

### 6. Configure environment

Copy and edit the API `.env` file:

```bash
cp apps/api/.env.example apps/api/.env
```

| Variable        | Description                              | Default                            |
|-----------------|------------------------------------------|------------------------------------|
| `RUNTIME_TYPE`  | Container runtime (`podman` or `fake`)   | `podman`                           |
| `PODMAN_SOCKET` | Path to rootful podman API socket        | `/run/boilerhouse/podman.sock`     |
| `SNAPSHOT_DIR`  | Directory for checkpoint archives        | `./data/snapshots`                 |
| `STORAGE_PATH`  | Tenant data storage directory            | `./data`                           |
| `WORKLOADS_DIR` | Path to workload TOML definitions        | *(none)*                           |
| `DB_PATH`       | SQLite database file path                | `boilerhouse.db`                   |
| `PORT`          | API server port                          | `3000`                             |
| `MAX_INSTANCES` | Maximum concurrent container instances   | `100`                              |

## Running

### Development

```bash
# API server (hot reload)
bun run dev

# Or run just the API
bun run --filter '@boilerhouse/api' dev
```

### Testing

```bash
# All tests
bun test --recursive

# API tests only
bun test apps/api/src/

# Podman runtime integration tests (requires podman + CRIU)
bun test packages/runtime-podman/src/

# E2E tests (runs with available runtimes)
bun test apps/api/src/e2e/

# Force specific runtimes for E2E
BOILERHOUSE_E2E_RUNTIMES=fake,podman bun test apps/api/src/e2e/
```

### Linting & Typechecking

```bash
bun run lint
bun run typecheck
```

## Project Structure

```
apps/
  api/              API server (ElysiaJS)
  dashboard/        Web dashboard (React)
packages/
  core/             Shared types, runtime interface, state machine
  db/               Drizzle ORM schema, migrations, helpers
  runtime-podman/   Podman + CRIU runtime implementation
workloads/          Workload TOML definitions
docs/               Design docs and plans
```
