import { describe, test, expect, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { DiskCache } from "./disk-cache";
import { EncryptedStore, hkdfKeyProvider } from "./encrypted-store";

let cacheDir: string;
let masterKey: string;

beforeEach(() => {
	cacheDir = mkdtempSync(join(tmpdir(), "encrypted-store-test-"));
	masterKey = randomBytes(32).toString("hex");
});

describe("EncryptedStore", () => {
	test("put + get round-trips a file through encryption", async () => {
		const inner = new DiskCache(cacheDir, 1024 * 1024);
		const store = new EncryptedStore(inner, hkdfKeyProvider(masterKey));

		const src = join(cacheDir, "plain.bin");
		writeFileSync(src, "secret tenant data");

		await store.put("tenant-1/workload-a", src);
		const path = await store.get("tenant-1/workload-a");

		expect(readFileSync(path, "utf-8")).toBe("secret tenant data");
	});

	test("putBuffer + get round-trips raw bytes", async () => {
		const inner = new DiskCache(cacheDir, 1024 * 1024);
		const store = new EncryptedStore(inner, hkdfKeyProvider(masterKey));

		await store.putBuffer("key-1", Buffer.from("buffer secret"));

		const path = await store.get("key-1");
		expect(readFileSync(path, "utf-8")).toBe("buffer secret");
	});

	test("has and delete pass through", async () => {
		const inner = new DiskCache(cacheDir, 1024 * 1024);
		const store = new EncryptedStore(inner, hkdfKeyProvider(masterKey));

		expect(await store.has("nope")).toBe(false);

		await store.putBuffer("exists", Buffer.from("x"));
		expect(await store.has("exists")).toBe(true);

		await store.delete("exists");
		expect(await store.has("exists")).toBe(false);
	});

	describe("at-rest encryption", () => {
		test("stored bytes do not contain plaintext", async () => {
			const inner = new DiskCache(cacheDir, 1024 * 1024);
			const store = new EncryptedStore(inner, hkdfKeyProvider(masterKey));
			const plaintext = "highly sensitive tenant overlay data 1234567890";

			await store.putBuffer("tenant-x/wk", Buffer.from(plaintext));

			const rawBytes = readFileSync(await inner.get("tenant-x/wk"));
			expect(rawBytes.toString("utf-8")).not.toContain(plaintext);
		});

		test("stored bytes include IV + ciphertext + auth tag overhead", async () => {
			const inner = new DiskCache(cacheDir, 1024 * 1024);
			const store = new EncryptedStore(inner, hkdfKeyProvider(masterKey));
			const plaintext = "hello";

			await store.putBuffer("overhead-test", Buffer.from(plaintext));

			const rawBytes = readFileSync(await inner.get("overhead-test"));
			// 12 (IV) + len(ciphertext) + 16 (GCM tag) > len(plaintext)
			expect(rawBytes.length).toBe(plaintext.length + 12 + 16);
		});

		test("same plaintext written twice produces different ciphertext (random IV)", async () => {
			const inner = new DiskCache(join(cacheDir, "iv-test"), 1024 * 1024);
			const store = new EncryptedStore(inner, hkdfKeyProvider(masterKey));

			await store.putBuffer("blob-1", Buffer.from("identical"));
			const raw1 = Buffer.from(readFileSync(await inner.get("blob-1")));

			// Overwrite with same plaintext
			await store.putBuffer("blob-1", Buffer.from("identical"));
			const raw2 = Buffer.from(readFileSync(await inner.get("blob-1")));

			expect(raw1.equals(raw2)).toBe(false);
		});
	});

	describe("key derivation from master key + blob key", () => {
		test("same master key + same blob key decrypts across store instances", async () => {
			const inner = new DiskCache(cacheDir, 1024 * 1024);
			const store1 = new EncryptedStore(inner, hkdfKeyProvider(masterKey));
			await store1.putBuffer("tenant-1/wk", Buffer.from("persistent"));

			// New store instance, same master key — should decrypt fine
			const store2 = new EncryptedStore(inner, hkdfKeyProvider(masterKey));
			const path = await store2.get("tenant-1/wk");
			expect(readFileSync(path, "utf-8")).toBe("persistent");
		});

		test("different master key cannot decrypt", async () => {
			const inner = new DiskCache(cacheDir, 1024 * 1024);
			const store = new EncryptedStore(inner, hkdfKeyProvider(masterKey));
			await store.putBuffer("locked", Buffer.from("private"));

			const wrongKey = randomBytes(32).toString("hex");
			const wrongStore = new EncryptedStore(inner, hkdfKeyProvider(wrongKey));
			expect(wrongStore.get("locked")).rejects.toThrow();
		});

		test("different tenant IDs derive different keys from the same master key", async () => {
			const inner = new DiskCache(cacheDir, 1024 * 1024);
			const store = new EncryptedStore(inner, hkdfKeyProvider(masterKey));
			const plaintext = Buffer.alloc(64, 0); // identical plaintext

			await store.putBuffer("tenant-alice/wk", plaintext);
			await store.putBuffer("tenant-bob/wk", plaintext);

			const rawAlice = readFileSync(await inner.get("tenant-alice/wk"));
			const rawBob = readFileSync(await inner.get("tenant-bob/wk"));

			// Same master key, same plaintext, different blob keys → different ciphertext
			expect(rawAlice.equals(rawBob)).toBe(false);
		});

		test("tenant A's ciphertext cannot be decrypted with tenant B's derived key", async () => {
			// Simulate reading tenant-alice's blob but deriving key with tenant-bob's blob key.
			// This can't happen through the store API (key is derived from the blob key automatically),
			// so we test the KeyProvider directly.
			const keyProvider = hkdfKeyProvider(masterKey);
			const keyAlice = await keyProvider("tenant-alice/wk");
			const keyBob = await keyProvider("tenant-bob/wk");

			expect(Buffer.from(keyAlice).equals(Buffer.from(keyBob))).toBe(false);
		});
	});
});
