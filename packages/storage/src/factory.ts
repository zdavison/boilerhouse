import { DiskCache } from "./disk-cache";
import { S3Backend } from "./s3-backend";
import { TieredStore } from "./tiered-store";
import { EncryptedStore, hkdfKeyProvider } from "./encrypted-store";
import type { BlobStore } from "./blob-store";

export interface BlobStoreConfig {
	/** Local cache directory. */
	cacheDir: string;
	/** Max cache size in bytes. */
	cacheMaxBytes: number;
	/** Enable S3 backend. When false, DiskCache is the primary store. */
	s3Enabled: boolean;
	/** S3 bucket name. Required when s3Enabled is true. */
	s3Bucket?: string;
	/** S3 region. */
	s3Region?: string;
	/** S3 endpoint (for MinIO, R2, Tigris). */
	s3Endpoint?: string;
	/** AWS access key ID. */
	s3AccessKeyId?: string;
	/** AWS secret access key. */
	s3SecretAccessKey?: string;
	/** Key prefix in the S3 bucket. */
	s3Prefix?: string;
	/** Force path-style access (required for MinIO). */
	s3ForcePathStyle?: boolean;
	/**
	 * Hex-encoded master key for at-rest encryption (AES-256-GCM).
	 * When set, all blobs are encrypted before storage using per-blob
	 * keys derived via HKDF from this master key.
	 * Omit to store blobs unencrypted.
	 */
	encryptionKey?: string;
}

/**
 * Creates a BlobStore from configuration.
 *
 * When `s3Enabled` is true, returns a TieredStore (DiskCache + S3Backend).
 * When false, returns a DiskCache as the primary store — preserving the
 * current local-only behavior for dev and testing.
 *
 * When `encryptionKey` is set, wraps the store with AES-256-GCM encryption.
 */
export function createBlobStore(config: BlobStoreConfig): BlobStore {
	const cache = new DiskCache(config.cacheDir, config.cacheMaxBytes);

	let store: BlobStore;

	if (!config.s3Enabled) {
		store = cache;
	} else {
		if (!config.s3Bucket) {
			throw new Error("S3_BUCKET is required when S3_ENABLED=true");
		}

		const s3 = new S3Backend({
			bucket: config.s3Bucket,
			region: config.s3Region,
			endpoint: config.s3Endpoint,
			accessKeyId: config.s3AccessKeyId,
			secretAccessKey: config.s3SecretAccessKey,
			prefix: config.s3Prefix,
			forcePathStyle: config.s3ForcePathStyle,
		});

		store = new TieredStore(cache, s3);
	}

	if (config.encryptionKey) {
		store = new EncryptedStore(store, hkdfKeyProvider(config.encryptionKey));
	}

	return store;
}
