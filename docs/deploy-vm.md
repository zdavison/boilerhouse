# Deploying Boilerhouse on a VM

Boilerhouse is an infrastructure component that your application depends on.
This guide shows how to add boilerhouse to your application's deployment.

## Deployment model

Boilerhouse has two processes:

| Process | Runs | Why |
|---------|------|-----|
| **boilerhouse-podmand** | On the host (systemd) | Needs rootful podman + CRIU for checkpoint/restore. Cannot be containerized. |
| **boilerhouse-api** | In Docker (your compose stack) | Stateless-ish API server. Mounts the podmand socket. |

Your application talks to the boilerhouse API over HTTP. The API talks to
podmand over a unix socket on the host.

```
┌─── your docker-compose ──────────────────────────┐
│                                                   │
│  ┌─────────────┐    ┌──────────────────────┐      │
│  │  your app   │───▶│  boilerhouse-api     │      │
│  │             │    │  :3000               │      │
│  └─────────────┘    └──────────┬───────────┘      │
│                                │                  │
│  ┌──────────┐                  │                  │
│  │  caddy   │─────────────────▶│                  │
│  │  :443    │                  │                  │
│  └──────────┘                  │                  │
└────────────────────────────────┼──────────────────┘
                     mounted     │
                     socket      ▼
               ┌──────────────────────────┐
               │  boilerhouse-podmand     │
               │  (systemd, root)         │
               │  podman + CRIU           │
               └──────────────────────────┘
```

## Step 1: Install podmand on the host

### Using the binary (recommended)

Download the boilerhouse binary from the
[GitHub releases](https://github.com/<org>/boilerhouse/releases) page
and run the host installer:

```bash
# Download the latest release
curl -fsSL https://github.com/<org>/boilerhouse/releases/latest/download/boilerhouse-linux-amd64 \
  -o /usr/local/bin/boilerhouse
chmod +x /usr/local/bin/boilerhouse

# Install host dependencies + podmand systemd service
boilerhouse host install
```

This installs podman, CRIU, generates secrets, and starts podmand. It is
idempotent — safe to re-run.

### From source (development)

If you don't have the binary, clone the repo and run the API directly:

```bash
git clone <boilerhouse-repo> /opt/boilerhouse
cd /opt/boilerhouse && bun install --frozen-lockfile

# Install host deps manually (podman, criu, nftables) then:
bun apps/boilerhouse-podmand/src/main.ts   # in one terminal
bun apps/api/src/server.ts                 # in another
```

### What the installer does

1. Installs system packages: podman, crun, criu, nftables
2. Verifies CRIU works
3. Creates `boilerhouse` system user and directories
4. Generates secrets to `/etc/boilerhouse/`
5. Installs and starts `boilerhouse-podmand` systemd service
6. Configures nftables firewall (set `SKIP_FIREWALL=1` to skip)

### Configuration

Secrets and environment are in `/etc/boilerhouse/`:

| File | Purpose |
|------|---------|
| `podmand.env` | Podmand config (socket paths, HMAC key, snapshot dir) |
| `api.env` | API config (can be sourced to run the API directly) |

## Step 2: Run the boilerhouse API

You have three options for running the API.

### Option A: Run the binary directly

```bash
# Start the API (reads config from /etc/boilerhouse/api.env)
boilerhouse api start

# Or install as a systemd service
boilerhouse api install
```

### Option B: Run from source

```bash
# Run directly (foreground)
set -a && source /etc/boilerhouse/api.env && set +a
cd /opt/boilerhouse && bun apps/api/src/server.ts
```

Your application can reach the API at `http://localhost:3000`.

### Option C: Add to your docker-compose

### Build the image

Boilerhouse does not publish pre-built images yet. Either:

**Option A** — build from the repo (recommended for now):
```yaml
services:
  boilerhouse-api:
    build:
      context: ./vendor/boilerhouse   # or wherever you cloned it
      dockerfile: Dockerfile
```

**Option B** — reference a pre-built image (once published):
```yaml
services:
  boilerhouse-api:
    image: ghcr.io/<org>/boilerhouse-api:latest
```

### docker-compose snippet

Add this to your application's `docker-compose.yml`:

```yaml
services:
  # ... your application services ...

  boilerhouse-api:
    build:
      context: ./vendor/boilerhouse
      dockerfile: Dockerfile
    restart: unless-stopped
    volumes:
      # Mount the podmand socket from the host
      - /run/boilerhouse/runtime.sock:/run/boilerhouse/runtime.sock
      # Persistent storage (SQLite DB, tenant data)
      - boilerhouse-data:/data
    environment:
      RUNTIME_TYPE: podman
      RUNTIME_SOCKET: /run/boilerhouse/runtime.sock
      DB_PATH: /data/boilerhouse.db
      STORAGE_PATH: /data
      SNAPSHOT_DIR: /data/snapshots
      LISTEN_HOST: "0.0.0.0"
      PORT: "3000"
      BOILERHOUSE_SECRET_KEY: "${BOILERHOUSE_SECRET_KEY}"
      # Optional
      MAX_INSTANCES: "100"
      METRICS_PORT: "9464"
      METRICS_HOST: "0.0.0.0"
      # WORKLOADS_DIR: /app/workloads
    healthcheck:
      test: ["CMD", "bun", "-e", "fetch('http://localhost:3000/api/v1/workloads').then(r=>process.exit(r.ok?0:1))"]
      interval: 10s
      timeout: 5s
      retries: 3
      start_period: 10s

volumes:
  boilerhouse-data:
```

### Required environment variables

| Variable | Description | Generate with |
|----------|-------------|---------------|
| `BOILERHOUSE_SECRET_KEY` | AES-256 key for encrypting tenant secrets | `openssl rand -hex 32` |

Put it in your `.env` file alongside your other secrets.

### Connecting your app to boilerhouse

From other containers in the same compose stack, reach the API at:

```
http://boilerhouse-api:3000/api/v1/...
```

No auth token is needed for container-to-container traffic within the
compose network. If you expose boilerhouse externally (via Caddy or
another reverse proxy), add bearer token auth — see the Caddyfile in
`deploy/Caddyfile` for an example.

## Step 3: Expose externally (optional)

If you need external access to the boilerhouse API (e.g. for webhooks),
add a reverse proxy. Example using the Caddy config from this repo:

```yaml
services:
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    environment:
      BOILERHOUSE_DOMAIN: "${BOILERHOUSE_DOMAIN}"
      BOILERHOUSE_AUTH_TOKEN: "${BOILERHOUSE_AUTH_TOKEN}"
      BOILERHOUSE_TLS_EMAIL: "${BOILERHOUSE_TLS_EMAIL}"
      BOILERHOUSE_API_UPSTREAM: "boilerhouse-api:3000"

volumes:
  caddy-data:
  caddy-config:
```

Copy `deploy/Caddyfile` from this repo into your project. It handles
TLS, bearer token auth, rate limiting on webhooks, and security headers.

## Step 4: Monitoring (optional)

Boilerhouse exposes Prometheus metrics on port 9464. Add a scrape target:

```yaml
# In your prometheus.yml
scrape_configs:
  - job_name: boilerhouse
    scrape_interval: 15s
    static_configs:
      - targets: ["boilerhouse-api:9464"]
```

A Grafana dashboard is available at `deploy/grafana/boilerhouse.json`.

## Step 5: Firewall

If this VM is internet-facing, the `boilerhouse host install` command
configures nftables automatically (allows only SSH 22 and HTTPS 443
inbound). To skip: `boilerhouse host install --skip-firewall`.

To uninstall (including firewall rules): `boilerhouse host uninstall`.

## Workload definitions

Workload definitions (TOML files + Dockerfiles) tell boilerhouse what
container images to snapshot and how to configure them. You can either:

1. **Mount them into the container** via `WORKLOADS_DIR`:
   ```yaml
   volumes:
     - ./workloads:/app/workloads:ro
   environment:
     WORKLOADS_DIR: /app/workloads
   ```

2. **Create them via the API** at runtime:
   ```bash
   curl -X POST http://boilerhouse-api:3000/api/v1/workloads \
     -H 'Content-Type: application/json' \
     -d '{"name": "myapp", "image": "myapp:latest", ...}'
   ```

## Updating boilerhouse

```bash
# Update the code
cd /opt/boilerhouse && git pull && bun install --frozen-lockfile

# Restart podmand (if podmand code changed)
systemctl restart boilerhouse-podmand@boilerhouse

# Rebuild the API container
cd /path/to/your/app
docker compose up -d --build boilerhouse-api
```

## Full example

See the next section for a complete `docker-compose.yml` showing
boilerhouse alongside a typical application.

### Example: deploying "myapp" with boilerhouse

```yaml
# docker-compose.yml
services:
  myapp:
    build: .
    restart: unless-stopped
    ports:
      - "127.0.0.1:8080:8080"
    environment:
      BOILERHOUSE_URL: "http://boilerhouse-api:3000"
    depends_on:
      boilerhouse-api:
        condition: service_healthy

  boilerhouse-api:
    build:
      context: ./vendor/boilerhouse
      dockerfile: Dockerfile
    restart: unless-stopped
    volumes:
      - /run/boilerhouse/runtime.sock:/run/boilerhouse/runtime.sock
      - boilerhouse-data:/data
      - ./workloads:/app/workloads:ro
    environment:
      RUNTIME_TYPE: podman
      RUNTIME_SOCKET: /run/boilerhouse/runtime.sock
      DB_PATH: /data/boilerhouse.db
      STORAGE_PATH: /data
      SNAPSHOT_DIR: /data/snapshots
      LISTEN_HOST: "0.0.0.0"
      PORT: "3000"
      BOILERHOUSE_SECRET_KEY: "${BOILERHOUSE_SECRET_KEY}"
      WORKLOADS_DIR: /app/workloads
    healthcheck:
      test: ["CMD", "bun", "-e", "fetch('http://localhost:3000/api/v1/workloads').then(r=>process.exit(r.ok?0:1))"]
      interval: 10s
      timeout: 5s
      retries: 3
      start_period: 10s

  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    environment:
      BOILERHOUSE_DOMAIN: "${BOILERHOUSE_DOMAIN}"
      BOILERHOUSE_AUTH_TOKEN: "${BOILERHOUSE_AUTH_TOKEN}"
      BOILERHOUSE_TLS_EMAIL: "${BOILERHOUSE_TLS_EMAIL}"
      BOILERHOUSE_API_UPSTREAM: "boilerhouse-api:3000"

volumes:
  boilerhouse-data:
  caddy-data:
  caddy-config:
```
