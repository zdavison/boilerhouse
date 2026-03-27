import { createCipheriv, createDecipheriv, randomBytes, hkdf } from "node:crypto";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { BlobStore } from "./blob-store";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Resolves an encryption key for a given blob key.
 *
 * Today: HKDF from a master secret + the blob key.
 * Future: could prompt the tenant for a passphrase via a guard.
 */
export type KeyProvider = (blobKey: string) => Promise<Buffer>;

/**
 * Creates a KeyProvider that derives per-blob AES-256 keys using
 * HKDF-SHA256 from a master secret.
 *
 * The blob key (e.g. `tenantId/workloadId`) is used as the HKDF info
 * parameter, giving each blob a unique derived key.
 */
export function hkdfKeyProvider(masterKey: string): KeyProvider {
	const secret = Buffer.from(masterKey, "hex");
	return (blobKey: string) =>
		new Promise((resolve, reject) => {
			hkdf("sha256", secret, "", blobKey, 32, (err, key) => {
				if (err) reject(err);
				else resolve(Buffer.from(key));
			});
		});
}

/**
 * BlobStore wrapper that encrypts blobs at rest using AES-256-GCM.
 *
 * Format: [12-byte IV] [ciphertext] [16-byte auth tag]
 *
 * Wraps any BlobStore — the inner store only ever sees ciphertext.
 * Decryption happens on `get`, encryption on `put`/`putBuffer`.
 * `has` and `delete` pass through unchanged.
 */
export class EncryptedStore implements BlobStore {
	constructor(
		private readonly inner: BlobStore,
		private readonly keyProvider: KeyProvider,
	) {}

	async get(key: string): Promise<string> {
		const encryptedPath = await this.inner.get(key);
		const ciphertext = readFileSync(encryptedPath);
		const plaintext = await this.decrypt(key, ciphertext);

		// Write decrypted data to a temp file and return its path
		const tmpPath = join(tmpdir(), `boilerhouse-dec-${randomUUID()}`);
		writeFileSync(tmpPath, plaintext);
		return tmpPath;
	}

	async put(key: string, filePath: string): Promise<void> {
		const plaintext = readFileSync(filePath);
		const ciphertext = await this.encrypt(key, plaintext);

		const tmpPath = join(tmpdir(), `boilerhouse-enc-${randomUUID()}`);
		try {
			writeFileSync(tmpPath, ciphertext);
			await this.inner.put(key, tmpPath);
		} finally {
			try { unlinkSync(tmpPath); } catch {}
		}
	}

	async putBuffer(key: string, data: Buffer): Promise<void> {
		const ciphertext = await this.encrypt(key, data);
		await this.inner.putBuffer(key, ciphertext);
	}

	async has(key: string): Promise<boolean> {
		return this.inner.has(key);
	}

	async delete(key: string): Promise<void> {
		return this.inner.delete(key);
	}

	private async encrypt(key: string, plaintext: Buffer): Promise<Buffer> {
		const derivedKey = await this.keyProvider(key);
		const iv = randomBytes(IV_BYTES);
		const cipher = createCipheriv(ALGORITHM, derivedKey, iv);
		const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
		const tag = cipher.getAuthTag();
		// [IV][ciphertext][tag]
		return Buffer.concat([iv, encrypted, tag]);
	}

	private async decrypt(key: string, data: Buffer): Promise<Buffer> {
		const derivedKey = await this.keyProvider(key);
		const iv = data.subarray(0, IV_BYTES);
		const tag = data.subarray(data.length - TAG_BYTES);
		const ciphertext = data.subarray(IV_BYTES, data.length - TAG_BYTES);
		const decipher = createDecipheriv(ALGORITHM, derivedKey, iv);
		decipher.setAuthTag(tag);
		return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
	}
}
