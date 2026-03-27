import { describe, test, expect, beforeAll } from "bun:test";
import { randomBytes } from "node:crypto";
import { generateX25519Identity } from "age-encryption";
import {
	encryptArchive,
	decryptArchive,
	isEncryptedArchive,
	ArchiveDecryptionError,
} from "./archive-crypto";

const TEST_DATA = Buffer.from("checkpoint-archive-content-with-process-memory");

let TEST_KEY: string;
let OTHER_KEY: string;

beforeAll(async () => {
	TEST_KEY = await generateX25519Identity();
	OTHER_KEY = await generateX25519Identity();
});

describe("encryptArchive / decryptArchive", () => {
	test("round-trips data correctly", async () => {
		const encrypted = await encryptArchive(TEST_DATA, TEST_KEY);
		const decrypted = await decryptArchive(encrypted, TEST_KEY);
		expect(decrypted).toEqual(TEST_DATA);
	});

	test("encrypted output differs from plaintext", async () => {
		const encrypted = await encryptArchive(TEST_DATA, TEST_KEY);
		expect(encrypted).not.toEqual(TEST_DATA);
		expect(encrypted.length).toBeGreaterThan(TEST_DATA.length);
	});

	test("each encryption produces different ciphertext", async () => {
		const a = await encryptArchive(TEST_DATA, TEST_KEY);
		const b = await encryptArchive(TEST_DATA, TEST_KEY);
		expect(a).not.toEqual(b);
		// But both decrypt to the same thing
		expect(await decryptArchive(a, TEST_KEY)).toEqual(TEST_DATA);
		expect(await decryptArchive(b, TEST_KEY)).toEqual(TEST_DATA);
	});

	test("wrong key fails decryption", async () => {
		const encrypted = await encryptArchive(TEST_DATA, TEST_KEY);
		await expect(decryptArchive(encrypted, OTHER_KEY)).rejects.toBeInstanceOf(
			ArchiveDecryptionError,
		);
	});

	test("tampered ciphertext fails decryption", async () => {
		const encrypted = await encryptArchive(TEST_DATA, TEST_KEY);
		// Flip a byte well into the ciphertext body (past the age header)
		const idx = encrypted.length - 10;
		encrypted[idx] = (encrypted[idx] ?? 0) ^ 0xff;
		await expect(decryptArchive(encrypted, TEST_KEY)).rejects.toBeInstanceOf(
			ArchiveDecryptionError,
		);
	});

	test("rejects non-encrypted data", async () => {
		await expect(decryptArchive(TEST_DATA, TEST_KEY)).rejects.toBeInstanceOf(
			ArchiveDecryptionError,
		);
	});

	test("handles empty plaintext", async () => {
		const empty = Buffer.alloc(0);
		const encrypted = await encryptArchive(empty, TEST_KEY);
		const decrypted = await decryptArchive(encrypted, TEST_KEY);
		expect(decrypted).toEqual(empty);
	});

	test("handles large data", async () => {
		const large = randomBytes(1024 * 1024); // 1 MB
		const encrypted = await encryptArchive(large, TEST_KEY);
		const decrypted = await decryptArchive(encrypted, TEST_KEY);
		expect(decrypted).toEqual(large);
	});
});

describe("isEncryptedArchive", () => {
	test("returns true for age-encrypted data", async () => {
		const encrypted = await encryptArchive(TEST_DATA, TEST_KEY);
		expect(isEncryptedArchive(encrypted)).toBe(true);
	});

	test("returns false for plain data", () => {
		expect(isEncryptedArchive(TEST_DATA)).toBe(false);
	});

	test("returns false for short data", () => {
		expect(isEncryptedArchive(Buffer.alloc(4))).toBe(false);
	});

	test("returns false for empty buffer", () => {
		expect(isEncryptedArchive(Buffer.alloc(0))).toBe(false);
	});
});
