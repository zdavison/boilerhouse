# Deployment Lessons from oddjob.ooo

Findings from deploying boilerhouse to production (Hetzner VPS, Docker Compose, Caddy) as part of the oddjob.ooo project. These are gaps, bugs, and missing documentation discovered during the process.

---

## Bugs Fixed

### 1. Sidecar cert directory permissions (v0.1.6)

`mkdtempSync` creates directories with `0700` permissions. The envoy sidecar runs as user `envoy` (uid 101) and can't read cert files inside a root-owned `0700` directory. Works on macOS because Docker Desktop's VirtioFS remaps permissions.

**Fix:** `chmodSync(certsDir, 0o755)` after `mkdtempSync` in `packages/runtime-docker/src/sidecar.ts`.

### 2. Docker CI builds wrong API image

The `docker.yml` GitHub Actions workflow built the API image from the main `Dockerfile` without `--target api`. Since the last stage in the Dockerfile is `trigger-gateway`, the API image shipped with the wrong binary.

**Fix:** Added `target: api` to the build matrix in `.github/workflows/docker.yml`.

### 3. `*` wildcard breaks envoy YAML (v0.1.10)

A bare `*` in the network allowlist rendered as a YAML alias in the generated envoy config, crashing the proxy. The `*` domain also produced invalid cluster configs (e.g. `address: *`, `sni: *`).

**Fix:** Filter `*` from domain processing in `packages/envoy-config/src/config.ts`. Auto-add credential domains so they still get MITM + header injection. Use `ORIGINAL_DST` passthrough cluster for the catch-all.

### 4. ORIGINAL_DST needs listener filter (v0.1.11)

The `ORIGINAL_DST` cluster for `*` allowlist passthrough failed with `No downstream connection or no original_dst`. iptables `REDIRECT` changes the destination, and envoy needs the `original_dst` listener filter to recover the real address via `SO_ORIGINAL_DST`.

**Fix:** Added `envoy.filters.listener.original_dst` to both HTTP and TLS listeners in `packages/envoy-config/src/envoy-bootstrap.yaml.hbs`.

### 5. Hibernate failure leaves tenant stuck (v0.1.7)

When S3 overlay extraction fails during idle timeout (e.g. `NoSuchBucket`), the claim transitions to `releasing` but the error prevents completion. The tenant is stuck — new claims fail with `cannot apply 'created' in status 'releasing'`.

**Fix:** Catch overlay extraction errors in `TenantManager.release()`. Still destroy the instance, delete the claim, and set `statusDetail` on the instance with the error message. Previous snapshot is preserved.

---

## Missing Production Configuration

### 6. DOCKER_HOST_ADDRESS

When the boilerhouse API runs inside a Docker container and spawns sibling containers (workloads), health checks need to reach those containers. The API defaults to `127.0.0.1` for the endpoint host, which is the API container's own loopback — not the host.

**Required in docker-compose:**
```yaml
environment:
  DOCKER_HOST_ADDRESS: host.docker.internal
extra_hosts:
  - "host.docker.internal:host-gateway"
```

### 7. STORAGE_PATH must be a host path

Named Docker volumes don't work for `STORAGE_PATH` because the sidecar creates bind mounts using the path as-is. When `STORAGE_PATH=/data` maps to a named volume at `/var/lib/docker/volumes/foo/_data`, the sidecar tries to mount `/data/sidecar/envoy.yaml` — which doesn't exist on the host.

**Required:** Use a host path mount where the path is the same inside and outside the container:
```yaml
environment:
  STORAGE_PATH: /opt/boilerhouse-data
volumes:
  - /opt/boilerhouse-data:/opt/boilerhouse-data
```

### 8. METRICS_URL for dashboard

The dashboard proxies `/metrics` to `METRICS_URL` (default `http://localhost:9464`). When running in Docker Compose, `localhost` inside the dashboard container doesn't reach the API container.

**Required:**
```yaml
environment:
  METRICS_URL: http://boilerhouse-api:9464
```

### 9. LISTEN_HOST must be 0.0.0.0

Services binding to `127.0.0.1` inside containers aren't reachable through Docker port mapping. Both the boilerhouse API and any app servers need to bind to `0.0.0.0`.

### 10. Data directory ownership

The data directory (e.g. `/opt/boilerhouse-data`) must exist and be writable before the API container starts. If the container creates it, it's owned by root, and subsequent operations (like SQLite WAL files) may fail with permission errors.

**Required in deploy script:**
```bash
sudo mkdir -p /opt/boilerhouse-data
sudo chown deploy:deploy /opt/boilerhouse-data
```

---

## Missing Deployment Tooling

### 11. No production docker-compose template

Boilerhouse ships a dev docker-compose with observability (Prometheus, Grafana, Tempo) but no production compose template. Operators need to build their own, handling:
- Port binding (127.0.0.1 only for security)
- Volume mounts (host paths, not named volumes)
- Environment variables
- Docker socket access
- extra_hosts for Docker-in-Docker networking

### 12. No deploy script

Oddjob built a full interactive deploy script that:
- Prompts for missing env vars (saved to file for next run)
- Installs system dependencies (Docker, Caddy) via SSH
- Syncs code via rsync (excluding secrets, databases, node_modules)
- Uploads env files separately
- Configures Caddy with systemd environment injection
- Creates data directories with correct ownership
- Pulls images and starts services

### 13. No cleanup/nuke scripts

Needed for debugging and resetting state:
- Remove all boilerhouse-managed containers
- Prune Docker volumes
- Wipe SQLite databases and sidecar temp files

### 14. Caddy environment injection

The Caddyfile uses `{$VAR}` placeholders but Caddy running as a systemd service doesn't have those environment variables. Requires:
- An environment file (e.g. `/etc/caddy/environment`)
- A systemd override at `/etc/systemd/system/caddy.service.d/env.conf` with `EnvironmentFile=/etc/caddy/environment`
- `systemctl daemon-reload` before restarting Caddy

### 15. BOILERHOUSE_SECRET_KEY generation

Required for tenant secret encryption but not prominently documented. Generate with:
```bash
openssl rand -hex 32
```

---

## Missing Documentation

### 16. S3 bucket setup

- When S3 is enabled (`S3_ENABLED=true`), the bucket must exist before the API starts
- `NoSuchBucket` errors during hibernate leave tenants stuck (fixed in v0.1.7 but confusing)
- Hetzner Object Storage uses region-specific endpoints (e.g. `nbg1.your-objectstorage.com` vs `fsn1.your-objectstorage.com`) — the endpoint must match the bucket's region

### 17. Credential injection requires restricted mode

`network.credentials` only works with `access: "restricted"` because the envoy MITM proxy is what injects the headers. With `"unrestricted"` (formerly `"outbound"`), traffic bypasses envoy entirely and credentials are never injected.

For unrestricted egress with credential injection, use `restricted` + `allowlist: ["*", "api.anthropic.com"]`.

### 18. Workload health check endpoints

The default OpenClaw health check path `/__openclaw/control-ui-config.json` returns 404 when the control UI is disabled. Use `/health` instead, which returns `{"ok":true,"status":"live"}`.

### 19. Dev vs prod path differences

- Dev: `STORAGE_PATH` defaults to `./data` (relative, resolved by `path.resolve`)
- Prod: Must be an absolute host path that matches inside and outside the container
- Dev: `BH_DATA_DIR` defaults to `/tmp/boilerhouse-data` (ephemeral)
- Prod: Persistent path like `/opt/boilerhouse-data`

### 20. Guard and trigger configuration

No examples of:
- Multi-tenant access control via guards
- Allowlist guard with deny messages
- Telegram polling vs webhook trade-offs
- Trigger-to-workload driver configuration
