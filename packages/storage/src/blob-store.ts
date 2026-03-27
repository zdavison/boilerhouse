/**
 * Content-addressed blob storage interface.
 *
 * `key` is a content-addressed ID — e.g. `snapshotId` for snapshots,
 * `{tenantId}/{workloadId}` for overlays.
 *
 * `get()` returns a local filesystem path — callers never deal with S3
 * streams directly. This matches the current contract where runtimes
 * and TenantDataStore expect paths on disk.
 */
export interface BlobStore {
	/** Returns a local path to the blob. Throws if not found. */
	get(key: string): Promise<string>;

	/** Stores a file (or directory) under the given key. */
	put(key: string, filePath: string): Promise<void>;

	/** Stores raw bytes under the given key. */
	putBuffer(key: string, data: Buffer): Promise<void>;

	/** Returns true if the blob exists in the store. */
	has(key: string): Promise<boolean>;

	/** Deletes the blob from the store. */
	delete(key: string): Promise<void>;
}

export class BlobNotFoundError extends Error {
	constructor(key: string) {
		super(`Blob not found: ${key}`);
		this.name = "BlobNotFoundError";
	}
}
