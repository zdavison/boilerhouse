import { createReadStream, createWriteStream, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import {
	S3Client,
	GetObjectCommand,
	HeadObjectCommand,
	DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import type { BlobStore } from "./blob-store";
import { BlobNotFoundError } from "./blob-store";

export interface S3BackendConfig {
	bucket: string;
	region?: string;
	endpoint?: string;
	accessKeyId?: string;
	secretAccessKey?: string;
	/** Key prefix in the bucket (e.g. "snapshots/" or "overlays/"). */
	prefix?: string;
	/** Force path-style access (required for MinIO). */
	forcePathStyle?: boolean;
}

/**
 * S3-compatible blob storage backend.
 *
 * `get()` downloads to a temp file and returns the path.
 * Callers should use this behind a `TieredStore` which caches
 * downloads in a `DiskCache`.
 */
export class S3Backend implements BlobStore {
	private readonly client: S3Client;
	private readonly bucket: string;
	private readonly prefix: string;

	constructor(config: S3BackendConfig) {
		this.bucket = config.bucket;
		this.prefix = config.prefix ?? "";

		const credentials =
			config.accessKeyId && config.secretAccessKey
				? {
						accessKeyId: config.accessKeyId,
						secretAccessKey: config.secretAccessKey,
					}
				: undefined;

		this.client = new S3Client({
			region: config.region ?? "us-east-1",
			endpoint: config.endpoint,
			credentials,
			forcePathStyle: config.forcePathStyle ?? !!config.endpoint,
		});
	}

	async get(key: string): Promise<string> {
		const s3Key = this.s3Key(key);
		let response;
		try {
			response = await this.client.send(
				new GetObjectCommand({ Bucket: this.bucket, Key: s3Key }),
			);
		} catch (err: unknown) {
			if (isNotFound(err)) throw new BlobNotFoundError(key);
			throw err;
		}

		if (!response.Body) throw new BlobNotFoundError(key);

		// Stream to a temp file, then return its path.
		// The caller (TieredStore) will move this into the disk cache.
		const tmpPath = join(tmpdir(), `boilerhouse-s3-${randomUUID()}`);
		const body = response.Body as Readable;
		await pipeline(body, createWriteStream(tmpPath));
		return tmpPath;
	}

	async put(key: string, filePath: string): Promise<void> {
		const s3Key = this.s3Key(key);
		const body = createReadStream(filePath);
		const size = statSync(filePath).size;

		const upload = new Upload({
			client: this.client,
			params: {
				Bucket: this.bucket,
				Key: s3Key,
				Body: body,
				ContentLength: size,
			},
			// Use multipart for files > 5 MiB
			partSize: 5 * 1024 * 1024,
			queueSize: 4,
		});
		await upload.done();
	}

	async putBuffer(key: string, data: Buffer): Promise<void> {
		const s3Key = this.s3Key(key);
		const upload = new Upload({
			client: this.client,
			params: {
				Bucket: this.bucket,
				Key: s3Key,
				Body: data,
				ContentLength: data.length,
			},
		});
		await upload.done();
	}

	async has(key: string): Promise<boolean> {
		try {
			await this.client.send(
				new HeadObjectCommand({ Bucket: this.bucket, Key: this.s3Key(key) }),
			);
			return true;
		} catch (err: unknown) {
			if (isNotFound(err)) return false;
			throw err;
		}
	}

	async delete(key: string): Promise<void> {
		await this.client.send(
			new DeleteObjectCommand({ Bucket: this.bucket, Key: this.s3Key(key) }),
		);
	}

	private s3Key(key: string): string {
		return this.prefix + key;
	}
}

function isNotFound(err: unknown): boolean {
	if (typeof err !== "object" || err === null) return false;
	const code = (err as { name?: string; $metadata?: { httpStatusCode?: number } });
	return code.name === "NoSuchKey" || code.name === "NotFound" || code.$metadata?.httpStatusCode === 404;
}
