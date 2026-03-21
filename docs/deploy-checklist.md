# Deployment Readiness Checklist

Boilerhouse is an infrastructure component consumed by other applications.
This tracks what's needed for consumers to deploy it.

## Ready

- [x] **Dockerfile** — builds the API image (`oven/bun:1-alpine` based)
- [x] **CLI binary** — `boilerhouse host install` sets up the VM (systemd units, firewall, secrets)
- [x] **Reverse proxy config** — `deploy/Caddyfile` (Caddy, auto-TLS, auth, rate limiting)
- [x] **Observability** — Prometheus scrape config + Grafana dashboard
- [x] **Deployment guides** — `docs/deploy-vm.md`, `docs/deploy-kubernetes.md`
- [x] **docker-compose snippet** — documented in deploy-vm.md for consumers to copy
- [x] **Security hardening** — systemd sandboxing, socket permissions, encrypted secrets

## Still needed

### High priority

- [ ] **Binary releases** — publish the `boilerhouse` binary via GitHub Actions CI
  to GitHub Releases (linux-amd64, linux-arm64). The binary already bundles
  `host install`, `api start`, `api install`, and `podmand start`.

- [ ] **Published container image** — publish to ghcr.io via CI so consumers
  don't need to build the Docker image themselves.

- [ ] **Database migrations** — `initDatabase()` creates tables on first run,
  but schema changes over time need a migration strategy. Drizzle Kit can
  generate migrations; should run on startup.

- [ ] **Health check endpoint** — the API lacks a dedicated `/healthz` that
  verifies DB + runtime connectivity. Needed for compose healthchecks and
  K8s readiness probes. (podmand has `/healthz`; the API should too.)

### Medium priority

- [ ] **Backup documentation** — SQLite DB + snapshot archives need backups.
  Document recommended approach (e.g. `sqlite3 .backup` + rclone).

- [ ] **Secrets rotation** — document how to rotate `BOILERHOUSE_SECRET_KEY`
  without downtime (requires re-encrypting stored tenant secrets).

### Low priority

- [ ] **Helm chart** — for Kubernetes consumers who prefer Helm over raw manifests.

- [ ] **Multi-node** — the DB schema supports multiple nodes, but there's no
  orchestration for distributing tenants across nodes yet.

## Deployment model

**VM (recommended)**: Install the `boilerhouse` binary (or run from
source). `boilerhouse host install` sets up the host and starts podmand.
Then run the API either via the binary, as a systemd service, or as a
Docker container in your compose stack. See `docs/deploy-vm.md`.

**Kubernetes**: No podmand or host setup needed. The API runs as a
Deployment and creates tenant instances as K8s pods directly. No
CRIU/snapshots. See `docs/deploy-kubernetes.md`.
