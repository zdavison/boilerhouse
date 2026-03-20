# Security Recommendations — Hetzner VM Deployment

Pre-deployment security fixes for running boilerhouse on a single Hetzner VM
with the Podman runtime.

## Priority Levels

- **P0 — Must fix before deployment.** Exploitable with low effort from the network.
- **P1 — Fix before any external traffic.** Needed once the VM is reachable beyond your own IP.
- **P2 — Fix soon after deployment.** Defense-in-depth; limits blast radius.

---

## P0 — Critical

### 1. Put the API behind a reverse proxy with authentication

**Problem:** The API server (`0.0.0.0:3000`) has zero authentication. Anyone
who can reach port 3000 can create/destroy workloads, claim tenants, manage
secrets, and read the full event stream over WebSocket.

**Fix:**

1. Bind the API to `127.0.0.1:3000` (add `hostname` option to `app.listen()`
   in `apps/api/src/server.ts`).
2. Deploy **Caddy** or **nginx** as a reverse proxy on port 443 with:
   - TLS termination (Caddy does automatic HTTPS via Let's Encrypt; for
     Hetzner you can use the DNS challenge or HTTP challenge).
   - Authentication — pick one:
     - **API key in header** (simplest): proxy checks `Authorization: Bearer <key>`
       before forwarding. Good enough for a single-operator deployment.
     - **mTLS**: issue client certs for each caller. Strongest for
       machine-to-machine.
     - **OAuth2 / OIDC proxy** (e.g. `oauth2-proxy`): if humans access the
       dashboard.
   - Forward `X-Forwarded-For` / `X-Real-IP` headers for logging.
3. Firewall (see item 3 below) blocks direct access to 3000 from the outside.

**Caddy example** (`/etc/caddy/Caddyfile`):

```caddyfile
boilerhouse.example.com {
    @authed header Authorization "Bearer {env.BOILERHOUSE_API_KEY}"

    handle /api/* {
        reverse_proxy 127.0.0.1:3000
    }
    handle /ws {
        reverse_proxy 127.0.0.1:3000
    }
    handle /hooks/* {
        # Webhooks have their own HMAC auth — pass through
        reverse_proxy 127.0.0.1:3000
    }
    handle {
        respond "Unauthorized" 401
    }
}
```

If you want the dashboard publicly reachable behind OAuth2, add an
`oauth2-proxy` sidecar in front of the `/` path.

### 2. Require `BOILERHOUSE_SECRET_KEY` and `BOILERHOUSE_HMAC_KEY`

**Problem:** Both keys are optional. Without `SECRET_KEY`, credential
injection silently fails and secrets endpoints return 501. Without `HMAC_KEY`,
snapshot archives have no integrity protection — a tampered CRIU image
restores attacker-controlled code.

**Fix:**

- Fail hard on startup if either key is missing. In `apps/api/src/server.ts`,
  change the `if (!secretKey)` warning to a fatal error.
- Generate keys before first run:
  ```sh
  # 32-byte hex key for AES-256-GCM
  export BOILERHOUSE_SECRET_KEY=$(openssl rand -hex 32)
  # Separate key for HMAC
  export BOILERHOUSE_HMAC_KEY=$(openssl rand -hex 32)
  ```
- Store them in a `.env` file readable only by the boilerhouse user
  (`chmod 0600`), loaded by the systemd service via `EnvironmentFile=`.

### 3. Host firewall (iptables / nftables)

**Problem:** Hetzner VMs have all ports open by default. The API, metrics
endpoint, and Envoy admin ports are all on `0.0.0.0`.

**Fix — nftables example** (`/etc/nftables.conf`):

```nft
#!/usr/sbin/nft -f
flush ruleset

table inet filter {
    chain input {
        type filter hook input priority 0; policy drop;

        # Loopback
        iif lo accept

        # Established/related
        ct state established,related accept

        # SSH (restrict to your IP if possible)
        tcp dport 22 accept

        # HTTPS (reverse proxy)
        tcp dport 443 accept

        # ICMP
        ip protocol icmp accept
        ip6 nexthdr icmpv6 accept
    }

    chain forward {
        type filter hook forward priority 0; policy drop;
    }

    chain output {
        type filter hook output priority 0; policy accept;
    }
}
```

This blocks external access to:
- `:3000` (API — only reachable via localhost reverse proxy)
- `:9464` (metrics — only reachable from localhost / Prometheus)
- `:18081` (Envoy admin — container-internal only, but defense-in-depth)

Enable with `systemctl enable --now nftables`.

---

## P1 — High

### 4. Bind metrics to localhost

**Problem:** The Prometheus exporter in `packages/o11y/src/provider.ts` binds
to all interfaces on port 9464. Metrics leak operational data (instance
counts, workload names, error rates).

**Fix:** Pass `host: '127.0.0.1'` to `PrometheusExporter`:

```typescript
const prometheusExporter = new PrometheusExporter({
    port: opts.metricsPort ?? 9464,
    host: '127.0.0.1',
});
```

The firewall (P0-3) already blocks this port, but binding to localhost is
defense-in-depth.

### 5. Rate limiting on webhook endpoints

**Problem:** `/hooks/:name`, `/slack/events`, and `/telegram/webhooks/:token`
are internet-facing (they must be, for webhook delivery). Without rate
limiting, an attacker can flood triggers to repeatedly claim/release tenants
or exhaust resources.

**Fix:** Add rate limiting at the reverse proxy layer. Caddy example:

```caddyfile
handle /hooks/* {
    rate_limit {remote.ip} 10r/s
    reverse_proxy 127.0.0.1:3000
}
```

Or use an Elysia rate-limit plugin (`elysia-rate-limit`) applied to the
webhook route group.

### 6. Add HTTP security headers

**Problem:** No security headers are set. The dashboard (React SPA) is
vulnerable to clickjacking, MIME sniffing, etc.

**Fix:** Set headers at the reverse proxy:

```caddyfile
header {
    X-Content-Type-Options "nosniff"
    X-Frame-Options "DENY"
    Referrer-Policy "strict-origin-when-cross-origin"
    Permissions-Policy "camera=(), microphone=(), geolocation=()"
    -Server
}
```

If using Caddy with automatic HTTPS, `Strict-Transport-Security` is added
automatically.

### 7. Restrict CORS

**Problem:** No CORS headers are set. While this means browsers default to
same-origin (which is fine), it also means the API doesn't explicitly reject
cross-origin requests. A malicious page could exploit CORS preflight
omissions for simple requests (GET, POST with `text/plain`).

**Fix:** Add Elysia CORS plugin with explicit origin allowlist:

```typescript
import { cors } from '@elysiajs/cors';

app.use(cors({
    origin: ['https://boilerhouse.example.com'],
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true,
}));
```

### 8. Validate tenant ID format

**Problem:** Tenant IDs from URL params are cast directly as `TenantId`
without format validation (`const tenantId = params.id as TenantId`). If
tenant IDs should be UUIDs, enforce it.

**Fix:** Add Elysia param validation in route definitions:

```typescript
params: t.Object({
    id: t.String({ pattern: '^[0-9a-f]{8}-[0-9a-f]{4}-' })
})
```

Or validate centrally via a `derive` plugin.

---

## P2 — Medium

### 9. Systemd hardening for the API server

**Problem:** `boilerhouse-podmand` has a hardened systemd unit, but there's
no systemd unit for the API server itself. If run manually or via a basic
service file, it runs with unnecessary privileges.

**Fix:** Create `deploy/boilerhouse-api.service`:

```ini
[Unit]
Description=Boilerhouse API Server
After=network.target boilerhouse-podmand.service

[Service]
Type=simple
User=boilerhouse
Group=boilerhouse
EnvironmentFile=/etc/boilerhouse/env
ExecStart=/usr/local/bin/bun run /opt/boilerhouse/apps/api/src/server.ts
Restart=on-failure
RestartSec=5

# Hardening
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
NoNewPrivileges=true
ReadWritePaths=/var/lib/boilerhouse
CapabilityBoundingSet=
SystemCallFilter=@system-service

[Install]
WantedBy=multi-user.target
```

### 10. Snapshot archive encryption at rest

**Problem:** CRIU snapshots contain full process memory. If the VM disk is
compromised (Hetzner rescue mode, snapshot download, decommissioned disk),
credentials in checkpoint images are exposed. HMAC protects integrity, not
confidentiality.

**Fix:** Either:
- **Encrypt snapshot archives** before writing to disk (AES-256-GCM using a
  dedicated key, similar to the secret store).
- **Use LUKS full-disk encryption** on the data partition. Hetzner supports
  this via installimage or manual setup. This protects all data at rest
  (SQLite DB, snapshots, env files).

LUKS is simpler to deploy and covers everything:

```sh
# During Hetzner installimage or rescue setup
cryptsetup luksFormat /dev/sda2
cryptsetup open /dev/sda2 data
mkfs.ext4 /dev/mapper/data
```

### 11. Log and audit access

**Problem:** No access logging for API requests. If someone exploits an
endpoint, there's no audit trail.

**Fix:**
- Enable request logging in the Elysia app (or at the reverse proxy).
- Ship logs to a persistent store (even a simple file with logrotate is
  better than nothing).
- Log at minimum: timestamp, client IP, method, path, status code, tenant ID
  (when applicable).

Caddy logs requests by default to `journald`.

### 12. Automatic security updates

**Problem:** A Hetzner VM needs OS-level patching. Unpatched kernel or
container runtime = container escape.

**Fix:**

```sh
# Debian/Ubuntu
apt install unattended-upgrades
dpkg-reconfigure -plow unattended-upgrades

# Enable security updates only
```

Keep Podman, CRIU, and Bun updated. Subscribe to their security advisories.

### 13. Backup the SQLite database and secrets

**Problem:** SQLite is a single file. Disk failure or accidental deletion
loses all state and encrypted secrets.

**Fix:**
- Use `sqlite3 .backup` or Litestream for continuous replication to Hetzner
  Object Storage (S3-compatible).
- Back up the `.env` file (encryption keys) separately — preferably offline
  or in a password manager.

---

## Deployment Checklist

```
Pre-deployment:
[ ] Generate BOILERHOUSE_SECRET_KEY and BOILERHOUSE_HMAC_KEY
[ ] Store keys in /etc/boilerhouse/env (chmod 0600, owned by boilerhouse user)
[ ] Make both keys required at startup (fail if missing)
[ ] Bind API server to 127.0.0.1:3000
[ ] Bind metrics to 127.0.0.1:9464
[ ] Install and configure Caddy/nginx with TLS + auth
[ ] Configure nftables (allow only 22, 443 inbound)
[ ] Enable nftables on boot
[ ] Create systemd units for API server and podmand
[ ] Enable unattended-upgrades
[ ] Set up LUKS or application-level snapshot encryption
[ ] Set up SQLite backups (Litestream → Hetzner Object Storage)

Post-deployment verification:
[ ] Port scan from external host confirms only 22 + 443 open
[ ] curl http://<ip>:3000 from external host is refused
[ ] curl http://<ip>:9464/metrics from external host is refused
[ ] API returns 401 without valid auth header
[ ] Webhook endpoints accept valid HMAC, reject invalid
[ ] Tenant secret CRUD works with encryption key set
[ ] CRIU snapshot/restore works and archives have valid HMAC
[ ] Dashboard loads over HTTPS
```
