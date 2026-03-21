# S3 Storage with Local LRU Disk Cache

## Problem

Boilerhouse stores two categories of large binary artifacts on local disk:

1. **Snapshot archives** — CRIU checkpoint archives in `{SNAPSHOT_DIR}/{snapshotId}/`
   - Podman: single archive per snapshot (`archive.tar.zst` or similar)
   - Kubernetes: `workload.json` + `overlay.tar.gz` per snapshot

2. **Tenant overlays** — per-tenant filesystem diffs in `{STORAGE_PATH}/{tenantId}/{workloadId}/overlay.tar.gz`

Everything else (SQLite DB, secrets, logs, activity log, Envoy configs) is either ephemeral, already in the DB, or metadata — it does not need S3.

Local-only storage means:
- Disk fills up as snapshots accumulate
- No cross-node sharing of snapshots or overlays
- No durability beyond the host machine

---

## Scope of Change

| Artifact | Needs S3+Cache? | Notes |
|---|---|---|
| Snapshot archives (CRIU) | **Yes** | Large, reused heavily for golden snapshots |
| Tenant overlays | **Yes** | Per-tenant, must be available on any node |
| SQLite database | No | Metadata only; stays local |
| Bootstrap logs | No | In SQLite |
| Secrets | No | In SQLite, encrypted |
| Activity log | No | In SQLite |
| Envoy proxy configs | No | Ephemeral temp files |
| Runtime/podman sockets | No | Not data |

---

## Existing Library Options

### S3 client
**`@aws-sdk/client-s3`** — the standard. Use `@aws-sdk/lib-storage` for multipart upload of large archives.

Compatible with any S3-API endpoint (Cloudflare R2, MinIO, Tigris, etc.) via `endpoint` config — no lock-in.

### Disk LRU cache
Options evaluated:

| Library | Notes |
|---|---|
| **`cacache`** | Used by npm. Content-addressed, integrity-verified (SHA-512), concurrent-safe, LRU via `cacache.ls()` + manual eviction. Good fit — we already do HMAC on archives. |
| Custom | Simple to build since artifacts are already content-addressed by `snapshotId`. Fewer deps. |
| `node-cache` / `lru-cache` | In-memory only — not suitable for GBs of archive data. |

**Recommendation: build a thin custom `DiskCache` class** backed by the filesystem. Simpler than pulling in `cacache`, and our access patterns are straightforward (get by snapshotId, put, evict LRU). We already have HMAC integrity on archives.

If we want future-proofing or concurrent write safety, `cacache` is a drop-in upgrade.

---

## Proposed Architecture

### New package: `packages/storage`

A single unified storage abstraction that both runtimes (Podman and Kubernetes) and `TenantDataStore` use instead of direct `fs` calls.

```
packages/storage/
  src/
    blob-store.ts        # BlobStore interface
    disk-cache.ts        # Local LRU disk cache
    s3-backend.ts        # S3 backend (upload/download/exists/delete)
    tiered-store.ts      # TieredStore: cache-first, S3-fallback
    index.ts
```

#### `BlobStore` interface

```ts
interface BlobStore {
  get(key: string): Promise<string>        // returns local path to file
  put(key: string, filePath: string): Promise<void>
  has(key: string): Promise<boolean>
  delete(key: string): Promise<void>
}
```

`key` is a content-addressed ID — `snapshotId` for snapshots, `{tenantId}/{workloadId}` for overlays.

#### `DiskCache` (local LRU layer)

- Fixed max size (e.g. `SNAPSHOT_CACHE_MAX_BYTES`, default 50 GiB)
- Stores files under `{cacheDir}/{key}`
- Tracks access time and size in a small SQLite table (reuse `packages/db` or a standalone WAL DB)
- Evicts least-recently-used entries until under the size limit
- Eviction is async and runs after each `put`

#### `S3Backend`

- Wraps `@aws-sdk/client-s3`
- `put`: multipart upload via `@aws-sdk/lib-storage` (handles large archives)
- `get`: `GetObject` → stream to temp file → atomic rename into cache dir
- `has`: `HeadObject`
- `delete`: `DeleteObject`
- Bucket path structure: `snapshots/{snapshotId}/archive` and `overlays/{tenantId}/{workloadId}`

#### `TieredStore`

Composes `DiskCache` + `S3Backend`:

```
get(key):
  1. if key in DiskCache → return local path (update LRU access time)
  2. if key in S3 → download to DiskCache → return local path
  3. throw NotFoundError

put(key, filePath):
  1. upload to S3
  2. copy/link into DiskCache
  3. evict LRU if over size limit

delete(key):
  1. delete from S3
  2. evict from DiskCache
```

`get` returns a local path — callers (runtimes, TenantDataStore) don't need to know about S3. This matches the current contract where runtimes expect a path on disk.

---

## Integration Points

### `SnapshotRef` / `SnapshotPaths`

`vmstatePath` and `memoryPath` in `SnapshotRef` currently point to local disk paths. With the tiered store, these paths are resolved at restore time by calling `store.get(snapshotId)`. The DB stores only the key (snapshotId), not a local path.

`SnapshotRef.vmstatePath` / `memoryPath` become virtual — resolved on demand.

### Podman runtime (`packages/runtime-podman/src/runtime.ts`)

- `createSnapshot` (lines 231-282): after CRIU checkpoint completes, call `store.put(snapshotId, archivePath)` to push to S3 and cache locally.
- `restoreFromSnapshot` (cold restore path): call `store.get(snapshotId)` to get a local path before passing to CRIU/podman.

### Kubernetes runtime (`packages/runtime-kubernetes/src/runtime.ts`)

- Lines 218-246: after writing `workload.json` + `overlay.tar.gz`, call `store.put(snapshotId, snapshotDir)`. Bundle or store as separate keyed objects.
- On restore: `store.get(snapshotId)` to populate local dir before mount.

### `TenantDataStore` (`apps/api/src/tenant-data.ts`)

- `saveOverlay` (lines 19-30): after writing `overlay.tar.gz`, call `store.put(overlayKey, filePath)`.
- `getOverlay`: call `store.get(overlayKey)` to get local path.
- Current `copyFileSync` stays for the local write step; S3 upload happens in addition.

### `SnapshotManager` (`apps/api/src/snapshot-manager.ts`)

- `computeSnapshotSize` (lines 286-301): no change needed — can still stat the local cache copy.
- No other changes needed at this layer.

---

## Configuration (env vars)

```
# S3
S3_BUCKET=boilerhouse-snapshots
S3_REGION=us-east-1
S3_ENDPOINT=                      # optional, for R2/MinIO/Tigris
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=

# Local cache
SNAPSHOT_CACHE_DIR=./data/cache/snapshots
OVERLAY_CACHE_DIR=./data/cache/overlays
SNAPSHOT_CACHE_MAX_BYTES=53687091200   # 50 GiB default
OVERLAY_CACHE_MAX_BYTES=10737418240    # 10 GiB default

# Behaviour
S3_ENABLED=true          # set to false to keep local-only (dev/test)
```

When `S3_ENABLED=false`, `TieredStore` falls back to disk-only (`DiskCache` acts as the primary store). This preserves the current behaviour for local dev and integration tests.

---

## Migration

1. Existing snapshots on disk are **not automatically uploaded** on startup — they remain valid as local-only.
2. New snapshots are always written to S3 (if enabled).
3. On restore, if a snapshot is not in cache and not in S3, the existing cold-restore workflow (re-boot from image) applies — this already exists.
4. A one-time migration script (`scripts/migrate-snapshots-to-s3.ts`) can upload existing archives and is opt-in.

---

## Implementation Order

1. `packages/storage` — `BlobStore` interface, `DiskCache`, `S3Backend`, `TieredStore`
2. Wire `TieredStore` into `TenantDataStore` (simplest integration point, self-contained)
3. Wire into Podman runtime (snapshot create + cold restore path)
4. Wire into Kubernetes runtime
5. Update `SnapshotRef` path resolution
6. Update `server.ts` to instantiate store from env vars
7. Add unit tests for `DiskCache` eviction and `TieredStore` fallback logic
8. Update integration test setup to use `S3_ENABLED=false`

---

## Open Questions

- **Encryption at rest in S3**: archives are already HMAC-signed and optionally AES-256-GCM encrypted via `archive-crypto.ts`. S3 SSE (server-side encryption) is additive. Decision: enable SSE-S3 by default in bucket policy, keep client-side encryption as-is.
- **Multi-part key for K8s snapshots**: Kubernetes snapshots have two files (`workload.json` + `overlay.tar.gz`). Either tar them together before upload, or store as two keyed objects under the same snapshotId prefix (`{snapshotId}/workload.json`, `{snapshotId}/overlay`). Prefix approach is cleaner.
- **Cache warming**: golden snapshots are reused heavily. Consider pre-warming the cache at startup for all `status=ready` golden snapshots — reduces first-restore latency.
- **Concurrent downloads**: if two restore requests arrive simultaneously for a cold snapshot, both will attempt S3 download. Add a per-key mutex/promise dedup in `TieredStore.get`.
