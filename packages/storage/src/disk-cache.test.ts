import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DiskCache } from "./disk-cache";
import { BlobNotFoundError } from "./blob-store";

let cacheDir: string;

beforeEach(() => {
	cacheDir = mkdtempSync(join(tmpdir(), "disk-cache-test-"));
});

describe("DiskCache", () => {
	test("put + get round-trips a file", async () => {
		const cache = new DiskCache(cacheDir, 1024 * 1024);
		const src = join(cacheDir, "src.bin");
		writeFileSync(src, "hello-blob");

		await cache.put("my-key", src);
		const path = await cache.get("my-key");

		expect(readFileSync(path, "utf-8")).toBe("hello-blob");
	});

	test("putBuffer + get round-trips raw bytes", async () => {
		const cache = new DiskCache(cacheDir, 1024 * 1024);
		await cache.putBuffer("buf-key", Buffer.from("buffer-data"));

		const path = await cache.get("buf-key");
		expect(readFileSync(path, "utf-8")).toBe("buffer-data");
	});

	test("has returns true for existing keys and false for missing", async () => {
		const cache = new DiskCache(cacheDir, 1024 * 1024);
		expect(await cache.has("nope")).toBe(false);

		await cache.putBuffer("exists", Buffer.from("x"));
		expect(await cache.has("exists")).toBe(true);
	});

	test("delete removes the file and tracking", async () => {
		const cache = new DiskCache(cacheDir, 1024 * 1024);
		await cache.putBuffer("del-key", Buffer.from("to-delete"));
		expect(await cache.has("del-key")).toBe(true);

		await cache.delete("del-key");
		expect(await cache.has("del-key")).toBe(false);
		expect(cache.count).toBe(0);
	});

	test("get throws BlobNotFoundError for missing key", async () => {
		const cache = new DiskCache(cacheDir, 1024 * 1024);
		expect(cache.get("missing")).rejects.toBeInstanceOf(BlobNotFoundError);
	});

	test("hierarchical keys (tenantId/workloadId) work", async () => {
		const cache = new DiskCache(cacheDir, 1024 * 1024);
		await cache.putBuffer("tenant-1/workload-a", Buffer.from("overlay-data"));

		const path = await cache.get("tenant-1/workload-a");
		expect(readFileSync(path, "utf-8")).toBe("overlay-data");
		expect(path).toBe(join(cacheDir, "tenant-1/workload-a"));
	});

	describe("LRU eviction", () => {
		test("evicts oldest entry when over max size", async () => {
			// Max 20 bytes — each entry is 10 bytes
			const cache = new DiskCache(cacheDir, 20);

			await cache.putBuffer("a", Buffer.alloc(10, "a"));
			await cache.putBuffer("b", Buffer.alloc(10, "b"));
			expect(cache.count).toBe(2);
			expect(cache.size).toBe(20);

			// Adding c should evict a (oldest)
			await cache.putBuffer("c", Buffer.alloc(10, "c"));
			expect(cache.count).toBe(2);
			expect(await cache.has("a")).toBe(false);
			expect(await cache.has("b")).toBe(true);
			expect(await cache.has("c")).toBe(true);
		});

		test("accessing an entry updates its LRU position", async () => {
			const cache = new DiskCache(cacheDir, 20);

			await cache.putBuffer("a", Buffer.alloc(10, "a"));
			// Small delay so timestamps are distinct
			await new Promise((r) => setTimeout(r, 5));
			await cache.putBuffer("b", Buffer.alloc(10, "b"));
			await new Promise((r) => setTimeout(r, 5));

			// Touch "a" to make it more recent than "b"
			await cache.get("a");

			// Adding c should evict b (now oldest)
			await cache.putBuffer("c", Buffer.alloc(10, "c"));
			expect(await cache.has("a")).toBe(true);
			expect(await cache.has("b")).toBe(false);
			expect(await cache.has("c")).toBe(true);
		});
	});

	describe("startup scan", () => {
		test("picks up existing files on construction", async () => {
			// Pre-populate the cache dir
			writeFileSync(join(cacheDir, "pre-existing"), "data");

			const cache = new DiskCache(cacheDir, 1024 * 1024);
			expect(cache.count).toBe(1);
			expect(await cache.has("pre-existing")).toBe(true);
		});
	});
});
