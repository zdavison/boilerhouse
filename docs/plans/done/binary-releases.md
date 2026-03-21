# Binary Releases

## Status: DONE (CLI implemented, CI release pipeline still needed)

## Context

Boilerhouse is an infrastructure component consumed by other applications.
Currently, deploying it requires cloning the repo and having Bun installed.
We want to ship a single `boilerhouse` binary that bundles the API server,
podmand, and host setup tooling. Consumers download it from GitHub Releases
and run it directly — no Bun, no `node_modules`, no git clone.

This is the recommended non-Docker installation path for VMs.

## CLI design

```
boilerhouse host install   # Set up the VM: install podman/CRIU, create user, generate secrets, start podmand
boilerhouse host status    # Check host health (podmand, socket, CRIU, disk)
boilerhouse host uninstall # Remove systemd services and boilerhouse user (data preserved)

boilerhouse api start      # Run the API server (foreground)
boilerhouse api install    # Install the API as a systemd service

boilerhouse podmand start  # Run podmand (foreground, used by the systemd service)

boilerhouse update         # Download and install the latest version
boilerhouse version        # Print version + commit
```

### `boilerhouse host install`

Replaces `deploy/install.sh`. Same logic, but embedded in the binary so
there are no external script dependencies. Must be run as root.

Steps:
1. Detect distro (Ubuntu/Debian required, warn on others)
2. Install system packages: podman, crun, criu, nftables
3. Verify CRIU (`criu check`, `podman info`)
4. Create `boilerhouse` system user
5. Create directories: `/var/lib/boilerhouse/{data,snapshots}`, `/etc/boilerhouse/`, `/run/boilerhouse/`
6. Generate secrets if `/etc/boilerhouse/podmand.env` doesn't exist
7. Write systemd unit files (embedded in the binary, not copied from deploy/)
8. Enable and start `boilerhouse-podmand@boilerhouse`
9. Wait for socket, report status
10. Optionally configure nftables (`--skip-firewall` to skip)

Idempotent — safe to re-run on upgrades.

### `boilerhouse api start`

Runs the API server. Reads config from environment variables (same as
today) or from `/etc/boilerhouse/api.env` if it exists and no env vars
are set.

### `boilerhouse podmand start`

Runs podmand. The systemd service unit calls this instead of
`bun apps/boilerhouse-podmand/src/main.ts`.

## Build

Use `bun build --compile` to produce a single self-contained binary.
This bundles the Bun runtime + all JS/TS source into one executable.

```bash
# API binary
bun build --compile apps/api/src/server.ts --outfile dist/boilerhouse-api

# Podmand binary
bun build --compile apps/boilerhouse-podmand/src/main.ts --outfile dist/boilerhouse-podmand
```

The final `boilerhouse` binary is a thin wrapper (or combined entrypoint)
that dispatches to the correct module based on the subcommand.

### Entrypoint structure

```
apps/cli/
├── src/
│   ├── main.ts           # CLI arg parser, dispatches subcommands
│   ├── commands/
│   │   ├── host-install.ts   # Embedded version of deploy/install.sh
│   │   ├── host-status.ts
│   │   ├── host-uninstall.ts
│   │   ├── api-start.ts      # Imports and runs the API server
│   │   ├── api-install.ts    # Writes systemd unit + enables
│   │   ├── podmand-start.ts  # Imports and runs podmand
│   │   └── version.ts
│   └── embedded/
│       ├── podmand.service.ts    # Systemd unit as a template string
│       ├── api.service.ts
│       └── nftables.conf.ts
```

Single compile target:
```bash
bun build --compile apps/cli/src/main.ts --outfile dist/boilerhouse
```

### Cross-compilation

Bun supports `--target` for cross-compilation:

```bash
bun build --compile --target=bun-linux-x64 apps/cli/src/main.ts --outfile dist/boilerhouse-linux-amd64
bun build --compile --target=bun-linux-arm64 apps/cli/src/main.ts --outfile dist/boilerhouse-linux-arm64
```

Only Linux targets are needed (podmand requires Linux for CRIU).

## GitHub Actions CI

### Workflow: `.github/workflows/release.yml`

Triggered on version tags (`v*`):

```yaml
name: Release
on:
  push:
    tags: ["v*"]

jobs:
  build:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        target: [bun-linux-x64, bun-linux-arm64]
        include:
          - target: bun-linux-x64
            artifact: boilerhouse-linux-amd64
          - target: bun-linux-arm64
            artifact: boilerhouse-linux-arm64
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun build --compile --target=${{ matrix.target }} apps/cli/src/main.ts --outfile ${{ matrix.artifact }}
      - uses: actions/upload-artifact@v4
        with:
          name: ${{ matrix.artifact }}
          path: ${{ matrix.artifact }}

  release:
    needs: build
    runs-on: ubuntu-latest
    permissions:
      contents: write
    steps:
      - uses: actions/download-artifact@v4
      - uses: softprops/action-gh-release@v2
        with:
          files: |
            boilerhouse-linux-amd64/boilerhouse-linux-amd64
            boilerhouse-linux-arm64/boilerhouse-linux-arm64
          generate_release_notes: true
```

### Workflow: `.github/workflows/docker.yml`

Triggered on tags and pushes to main. Builds and pushes the Docker image:

```yaml
name: Docker
on:
  push:
    branches: [main]
    tags: ["v*"]

jobs:
  build:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      packages: write
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          push: true
          tags: |
            ghcr.io/${{ github.repository }}/api:${{ github.ref_name }}
            ghcr.io/${{ github.repository }}/api:latest
```

## Implementation order

1. **Create `apps/cli/` package** with subcommand dispatcher
2. **Port `deploy/install.sh` to TypeScript** as `host-install.ts` —
   embed systemd units and nftables config as template strings
3. **Wire up `api start` and `podmand start`** — just import the existing
   entrypoints
4. **Add `bun build --compile`** step, verify the binary works on a clean VM
5. **Set up GitHub Actions** — release workflow on tags, docker workflow on push
6. **Update docs** — replace `<org>` placeholders with real URLs once the
   first release is published

## Update checking

The binary does **not** auto-update. Instead, it checks for newer versions
and notifies the user.

### Behavior

On any command, after the main work completes, the CLI checks for updates
in the background (non-blocking). If a newer version exists, it prints a
notice to stderr:

```
A new version of boilerhouse is available: v0.3.0 (current: v0.2.1)
Run `boilerhouse update` to install it.
```

The check is rate-limited — at most once per 24 hours. The last check
timestamp and result are cached in `/var/lib/boilerhouse/.update-check`.

### `boilerhouse update`

Downloads the latest binary from GitHub Releases and replaces the current
one in-place:

```bash
$ boilerhouse update
Downloading boilerhouse v0.3.0 (linux-amd64)...
Replacing /usr/local/bin/boilerhouse...
Updated to v0.3.0. Restart running services to use the new version:
  systemctl restart boilerhouse-podmand@boilerhouse
  systemctl restart boilerhouse-api   # if installed as a service
```

Steps:
1. Fetch latest release tag from GitHub API (`/repos/<org>/boilerhouse/releases/latest`)
2. Compare with compiled-in version — exit early if already current
3. Download the correct binary for the current arch (`uname -m`)
4. Write to a temp file, `chmod +x`, then atomically rename over the current binary
5. Print restart instructions (does not restart services automatically)

### Implementation

```ts
// apps/cli/src/update-check.ts

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CACHE_FILE = "/var/lib/boilerhouse/.update-check";
const GITHUB_RELEASES_URL = "https://api.github.com/repos/<org>/boilerhouse/releases/latest";

interface UpdateCache {
  lastCheck: number;
  latestVersion: string | null;
}

/** Non-blocking check, prints to stderr if update available. */
export function checkForUpdatesInBackground(currentVersion: string): void {
  // Fire-and-forget — never blocks the main command
  checkForUpdates(currentVersion).catch(() => {});
}

async function checkForUpdates(currentVersion: string): Promise<void> {
  const cache = readCache();
  if (cache && Date.now() - cache.lastCheck < CHECK_INTERVAL_MS) {
    if (cache.latestVersion && cache.latestVersion !== currentVersion) {
      printUpdateNotice(currentVersion, cache.latestVersion);
    }
    return;
  }

  const res = await fetch(GITHUB_RELEASES_URL, {
    headers: { "User-Agent": "boilerhouse-cli" },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return;

  const { tag_name } = await res.json() as { tag_name: string };
  const latest = tag_name.replace(/^v/, "");
  writeCache({ lastCheck: Date.now(), latestVersion: latest });

  if (latest !== currentVersion) {
    printUpdateNotice(currentVersion, latest);
  }
}

function printUpdateNotice(current: string, latest: string): void {
  console.error(`\nA new version of boilerhouse is available: v${latest} (current: v${current})`);
  console.error("Run `boilerhouse update` to install it.\n");
}
```

## Open questions

- **Arg parser**: use `commander` for subcommand parsing.
- **Versioning**: use git tags (`v0.1.0`) and embed the version at compile
  time via `--define`.
