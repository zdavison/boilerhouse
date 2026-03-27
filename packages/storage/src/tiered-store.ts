import type { BlobStore } from "./blob-store";
import type { DiskCache } from "./disk-cache";
import type { S3Backend } from "./s3-backend";

/**
 * Two-tier blob store: local disk cache + S3 backend.
 *
 * - `get`: cache hit → return local path; cache miss → download from S3 → cache → return
 * - `put`: upload to S3, then cache locally
 * - `delete`: remove from both
 *
 * Uses a per-key mutex to deduplicate concurrent downloads of the same key.
 */
export class TieredStore implements BlobStore {
	private readonly inflight = new Map<string, Promise<string>>();

	constructor(
		private readonly cache: DiskCache,
		private readonly s3: S3Backend,
	) {}

	async get(key: string): Promise<string> {
		// 1. Check local cache
		if (await this.cache.has(key)) {
			return this.cache.get(key);
		}

		// 2. Deduplicate concurrent downloads for the same key
		const existing = this.inflight.get(key);
		if (existing) return existing;

		const download = this.downloadAndCache(key);
		this.inflight.set(key, download);
		try {
			return await download;
		} finally {
			this.inflight.delete(key);
		}
	}

	async put(key: string, filePath: string): Promise<void> {
		// Upload to S3 first (source of truth), then cache locally
		await this.s3.put(key, filePath);
		await this.cache.put(key, filePath);
	}

	async putBuffer(key: string, data: Buffer): Promise<void> {
		await this.s3.putBuffer(key, data);
		await this.cache.putBuffer(key, data);
	}

	async has(key: string): Promise<boolean> {
		if (await this.cache.has(key)) return true;
		return this.s3.has(key);
	}

	async delete(key: string): Promise<void> {
		await Promise.all([this.s3.delete(key), this.cache.delete(key)]);
	}

	private async downloadAndCache(key: string): Promise<string> {
		// Download from S3 to a temp file
		const tmpPath = await this.s3.get(key);

		// Move into disk cache
		await this.cache.put(key, tmpPath);

		// Clean up the temp file (cache.put copies it)
		try {
			const { unlinkSync } = await import("node:fs");
			unlinkSync(tmpPath);
		} catch {
			// temp file already moved or cleaned
		}

		return this.cache.get(key);
	}
}
