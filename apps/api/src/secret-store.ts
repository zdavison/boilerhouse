import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { eq, and } from "drizzle-orm";
import type { TenantId } from "@boilerhouse/core";
import type { DrizzleDb } from "@boilerhouse/db";
import { tenantSecrets } from "@boilerhouse/db";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const SECRET_REF_RE = /\$\{(global-secret|tenant-secret):(\w+)\}/g;

export class SecretStore {
	private readonly key: Buffer;

	constructor(
		private readonly db: DrizzleDb,
		hexKey: string,
	) {
		this.key = Buffer.from(hexKey, "hex");
		if (this.key.length !== 32) {
			throw new Error(
				`Encryption key must be 32 bytes (64 hex chars), got ${this.key.length} bytes`,
			);
		}
	}

	set(tenantId: TenantId, name: string, plaintext: string): void {
		const { encrypted, iv, authTag } = this.encrypt(plaintext);
		const now = new Date();

		const existing = this.db
			.select({ id: tenantSecrets.id })
			.from(tenantSecrets)
			.where(
				and(
					eq(tenantSecrets.tenantId, tenantId),
					eq(tenantSecrets.name, name),
				),
			)
			.get();

		if (existing) {
			this.db
				.update(tenantSecrets)
				.set({
					encryptedValue: encrypted,
					iv,
					authTag,
					updatedAt: now,
				})
				.where(eq(tenantSecrets.id, existing.id))
				.run();
		} else {
			this.db
				.insert(tenantSecrets)
				.values({
					tenantId,
					name,
					encryptedValue: encrypted,
					iv,
					authTag,
					createdAt: now,
					updatedAt: now,
				})
				.run();
		}
	}

	get(tenantId: TenantId, name: string): string | null {
		const row = this.db
			.select()
			.from(tenantSecrets)
			.where(
				and(
					eq(tenantSecrets.tenantId, tenantId),
					eq(tenantSecrets.name, name),
				),
			)
			.get();

		if (!row) return null;
		return this.decrypt(row.encryptedValue, row.iv, row.authTag);
	}

	list(tenantId: TenantId): string[] {
		return this.db
			.select({ name: tenantSecrets.name })
			.from(tenantSecrets)
			.where(eq(tenantSecrets.tenantId, tenantId))
			.all()
			.map((r) => r.name);
	}

	delete(tenantId: TenantId, name: string): void {
		this.db
			.delete(tenantSecrets)
			.where(
				and(
					eq(tenantSecrets.tenantId, tenantId),
					eq(tenantSecrets.name, name),
				),
			)
			.run();
	}

	/**
	 * Replaces `${global-secret:NAME}` and `${tenant-secret:NAME}` references
	 * in a template string with actual values.
	 * - `global-secret` resolves from `process.env`
	 * - `tenant-secret` resolves from the encrypted per-tenant DB store
	 * Throws if a referenced secret does not exist.
	 */
	resolveSecretRefs(tenantId: TenantId, template: string): string {
		return template.replace(SECRET_REF_RE, (_match, scope: string, name: string) => {
			if (scope === "global-secret") {
				const value = process.env[name];
				if (value === undefined) {
					throw new Error(
						`Global secret '${name}' not found in environment`,
					);
				}
				return value;
			}
			// tenant-secret
			const value = this.get(tenantId, name);
			if (value === null) {
				throw new Error(
					`Secret '${name}' not found for tenant '${tenantId}'`,
				);
			}
			return value;
		});
	}

	private encrypt(plaintext: string): {
		encrypted: string;
		iv: string;
		authTag: string;
	} {
		const iv = randomBytes(IV_LENGTH);
		const cipher = createCipheriv(ALGORITHM, this.key, iv);
		const encrypted = Buffer.concat([
			cipher.update(plaintext, "utf-8"),
			cipher.final(),
		]);
		const authTag = cipher.getAuthTag();

		return {
			encrypted: encrypted.toString("base64"),
			iv: iv.toString("base64"),
			authTag: authTag.toString("base64"),
		};
	}

	private decrypt(
		encryptedB64: string,
		ivB64: string,
		authTagB64: string,
	): string {
		const decipher = createDecipheriv(
			ALGORITHM,
			this.key,
			Buffer.from(ivB64, "base64"),
		);
		decipher.setAuthTag(Buffer.from(authTagB64, "base64"));
		return (
			decipher.update(Buffer.from(encryptedB64, "base64"), undefined, "utf-8") +
			decipher.final("utf-8")
		);
	}
}
