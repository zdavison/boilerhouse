import { mkdirSync, existsSync, statSync, unlinkSync, copyFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { BlobStore } from "./blob-store";
import { BlobNotFoundError } from "./blob-store";

interface CacheEntry {
	key: string;
	sizeBytes: number;
	lastAccessedAt: number;
}

/**
 * Local LRU disk cache implementing the BlobStore interface.
 *
 * Stores blobs under `{cacheDir}/{key}` (key may contain `/` for
 * hierarchical keys like `{tenantId}/{workloadId}`).
 *
 * Tracks access time and size in-memory and evicts least-recently-used
 * entries when the total size exceeds `maxBytes`.
 */
export class DiskCache implements BlobStore {
	private readonly entries = new Map<string, CacheEntry>();
	private totalBytes = 0;

	constructor(
		private readonly cacheDir: string,
		private readonly maxBytes: number,
	) {
		mkdirSync(cacheDir, { recursive: true });
		this.scan();
	}

	async get(key: string): Promise<string> {
		const filePath = this.keyPath(key);
		if (!existsSync(filePath)) {
			this.entries.delete(key);
			throw new BlobNotFoundError(key);
		}
		this.touch(key);
		return filePath;
	}

	async put(key: string, filePath: string): Promise<void> {
		const dest = this.keyPath(key);
		mkdirSync(join(dest, ".."), { recursive: true });
		copyFileSync(filePath, dest);
		this.track(key, dest);
		this.evict();
	}

	async putBuffer(key: string, data: Buffer): Promise<void> {
		const dest = this.keyPath(key);
		mkdirSync(join(dest, ".."), { recursive: true });
		writeFileSync(dest, data);
		this.track(key, dest);
		this.evict();
	}

	async has(key: string): Promise<boolean> {
		return existsSync(this.keyPath(key));
	}

	async delete(key: string): Promise<void> {
		const filePath = this.keyPath(key);
		const entry = this.entries.get(key);
		if (entry) {
			this.totalBytes -= entry.sizeBytes;
			this.entries.delete(key);
		}
		try {
			unlinkSync(filePath);
		} catch {
			// already gone
		}
	}

	/** Current total size of cached files in bytes. */
	get size(): number {
		return this.totalBytes;
	}

	/** Number of entries in the cache. */
	get count(): number {
		return this.entries.size;
	}

	// ── Internal ──────────────────────────────────────────────────────────

	private keyPath(key: string): string {
		return join(this.cacheDir, key);
	}

	private touch(key: string): void {
		const entry = this.entries.get(key);
		if (entry) {
			entry.lastAccessedAt = Date.now();
		}
	}

	private track(key: string, filePath: string): void {
		const oldEntry = this.entries.get(key);
		if (oldEntry) {
			this.totalBytes -= oldEntry.sizeBytes;
		}
		const sizeBytes = statSync(filePath).size;
		this.entries.set(key, { key, sizeBytes, lastAccessedAt: Date.now() });
		this.totalBytes += sizeBytes;
	}

	private evict(): void {
		if (this.totalBytes <= this.maxBytes) return;

		const sorted = [...this.entries.values()].sort(
			(a, b) => a.lastAccessedAt - b.lastAccessedAt,
		);

		for (const entry of sorted) {
			if (this.totalBytes <= this.maxBytes) break;
			try {
				unlinkSync(this.keyPath(entry.key));
			} catch {
				// already gone
			}
			this.totalBytes -= entry.sizeBytes;
			this.entries.delete(entry.key);
		}
	}

	/** Scan the cache directory on startup to populate the in-memory index. */
	private scan(): void {
		this.scanDir(this.cacheDir, "");
	}

	private scanDir(dir: string, prefix: string): void {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}
		for (const name of entries) {
			const fullPath = join(dir, name);
			const key = prefix ? `${prefix}/${name}` : name;
			try {
				const stat = statSync(fullPath);
				if (stat.isDirectory()) {
					this.scanDir(fullPath, key);
				} else if (stat.isFile()) {
					this.entries.set(key, {
						key,
						sizeBytes: stat.size,
						lastAccessedAt: stat.mtimeMs,
					});
					this.totalBytes += stat.size;
				}
			} catch {
				// skip inaccessible entries
			}
		}
	}
}
