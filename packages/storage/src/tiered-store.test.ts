import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DiskCache } from "./disk-cache";
import { TieredStore } from "./tiered-store";
import { BlobNotFoundError } from "./blob-store";
import type { BlobStore } from "./blob-store";

// A simple in-memory BlobStore that simulates S3
class FakeS3 implements BlobStore {
	private readonly blobs = new Map<string, Buffer>();

	async get(key: string): Promise<string> {
		const data = this.blobs.get(key);
		if (!data) throw new BlobNotFoundError(key);
		const tmp = mkdtempSync(join(tmpdir(), "fake-s3-get-"));
		const path = join(tmp, "blob");
		writeFileSync(path, data);
		return path;
	}

	async put(key: string, filePath: string): Promise<void> {
		this.blobs.set(key, Buffer.from(readFileSync(filePath)));
	}

	async putBuffer(key: string, data: Buffer): Promise<void> {
		this.blobs.set(key, Buffer.from(data));
	}

	async has(key: string): Promise<boolean> {
		return this.blobs.has(key);
	}

	async delete(key: string): Promise<void> {
		this.blobs.delete(key);
	}
}

let cacheDir: string;
let cache: DiskCache;
let fakeS3: FakeS3;
let store: TieredStore;

beforeEach(() => {
	cacheDir = mkdtempSync(join(tmpdir(), "tiered-store-test-"));
	cache = new DiskCache(cacheDir, 1024 * 1024);
	fakeS3 = new FakeS3();
	store = new TieredStore(cache, fakeS3 as unknown as import("./s3-backend").S3Backend);
});

describe("TieredStore", () => {
	test("put uploads to S3 and caches locally", async () => {
		const src = join(cacheDir, "src.bin");
		writeFileSync(src, "tiered-data");

		await store.put("key-1", src);

		// Both S3 and cache should have it
		expect(await fakeS3.has("key-1")).toBe(true);
		expect(await cache.has("key-1")).toBe(true);
	});

	test("get returns from cache when available (no S3 hit)", async () => {
		await cache.putBuffer("cached", Buffer.from("from-cache"));

		const path = await store.get("cached");
		expect(readFileSync(path, "utf-8")).toBe("from-cache");
	});

	test("get downloads from S3 on cache miss and caches for next time", async () => {
		// Put directly in fake S3, bypassing cache
		await fakeS3.putBuffer("s3-only", Buffer.from("from-s3"));
		expect(await cache.has("s3-only")).toBe(false);

		const path = await store.get("s3-only");
		expect(readFileSync(path, "utf-8")).toBe("from-s3");

		// Should now be cached
		expect(await cache.has("s3-only")).toBe(true);
	});

	test("get throws BlobNotFoundError when missing from both", async () => {
		expect(store.get("nowhere")).rejects.toBeInstanceOf(BlobNotFoundError);
	});

	test("has checks both cache and S3", async () => {
		expect(await store.has("nope")).toBe(false);

		await fakeS3.putBuffer("s3-only", Buffer.from("x"));
		expect(await store.has("s3-only")).toBe(true);

		await cache.putBuffer("cache-only", Buffer.from("y"));
		expect(await store.has("cache-only")).toBe(true);
	});

	test("delete removes from both S3 and cache", async () => {
		await store.putBuffer("both", Buffer.from("data"));
		expect(await fakeS3.has("both")).toBe(true);
		expect(await cache.has("both")).toBe(true);

		await store.delete("both");
		expect(await fakeS3.has("both")).toBe(false);
		expect(await cache.has("both")).toBe(false);
	});

	test("concurrent gets for same key deduplicate the download", async () => {
		let downloadCount = 0;
		const origGet = fakeS3.get.bind(fakeS3);
		fakeS3.get = async (key: string) => {
			downloadCount++;
			// Simulate slow download
			await new Promise((r) => setTimeout(r, 50));
			return origGet(key);
		};

		await fakeS3.putBuffer("dedup", Buffer.from("shared"));

		// Fire two concurrent gets
		const [p1, p2] = await Promise.all([store.get("dedup"), store.get("dedup")]);

		expect(readFileSync(p1, "utf-8")).toBe("shared");
		expect(readFileSync(p2, "utf-8")).toBe("shared");
		// Should only have downloaded once
		expect(downloadCount).toBe(1);
	});
});
