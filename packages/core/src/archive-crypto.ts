import { Encrypter, Decrypter, identityToRecipient } from "age-encryption";

/**
 * Thrown when decryption fails (bad key, tampered data, wrong format).
 */
export class ArchiveDecryptionError extends Error {
	constructor(message = "Archive decryption failed") {
		super(message);
		this.name = "ArchiveDecryptionError";
	}
}

/**
 * Encrypts an archive buffer using age (X25519 + ChaCha20-Poly1305).
 *
 * @param data - Plaintext archive data.
 * @param ageIdentity - age secret key ("AGE-SECRET-KEY-1...").
 * @returns Encrypted buffer in age format.
 */
export async function encryptArchive(data: Buffer, ageIdentity: string): Promise<Buffer<ArrayBuffer>> {
	const recipient = await identityToRecipient(ageIdentity);
	const e = new Encrypter();
	e.addRecipient(recipient);
	const encrypted = await e.encrypt(data);
	return Buffer.from(encrypted.buffer as ArrayBuffer, encrypted.byteOffset, encrypted.byteLength);
}

/**
 * Decrypts an archive buffer encrypted with {@link encryptArchive}.
 *
 * @param encrypted - age-encrypted data.
 * @param ageIdentity - age secret key ("AGE-SECRET-KEY-1...").
 * @throws {ArchiveDecryptionError} on bad key or tampered data.
 */
export async function decryptArchive(encrypted: Buffer, ageIdentity: string): Promise<Buffer<ArrayBuffer>> {
	try {
		const d = new Decrypter();
		d.addIdentity(ageIdentity);
		const decrypted = await d.decrypt(encrypted, "uint8array");
		return Buffer.from(decrypted.buffer as ArrayBuffer, decrypted.byteOffset, decrypted.byteLength);
	} catch (err) {
		throw new ArchiveDecryptionError(
			err instanceof Error ? err.message : "Archive decryption failed",
		);
	}
}

const AGE_MAGIC = "age-encryption.org/v1";

/**
 * Returns `true` if the buffer looks like an age-encrypted file.
 */
export function isEncryptedArchive(data: Buffer): boolean {
	return (
		data.length > AGE_MAGIC.length &&
		data.subarray(0, AGE_MAGIC.length).toString("ascii") === AGE_MAGIC
	);
}
