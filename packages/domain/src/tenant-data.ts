import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { eq, and } from "drizzle-orm";
import type { TenantId, WorkloadId, Runtime, InstanceHandle, Workload } from "@boilerhouse/core";
import type { DrizzleDb } from "@boilerhouse/db";
import { tenants, workloads } from "@boilerhouse/db";
import type { BlobStore } from "@boilerhouse/storage";
import { BlobNotFoundError } from "@boilerhouse/storage";

export interface TenantDataStoreOptions {
	/** Unencrypted blob store. */
	blobStore?: BlobStore;
	/** Encrypted blob store (used when workload has encrypt_overlays enabled). */
	encryptedBlobStore?: BlobStore;
}

export class TenantDataStore {
	private readonly blobStore?: BlobStore;
	private readonly encryptedBlobStore?: BlobStore;

	constructor(
		private readonly storagePath: string,
		private readonly db: DrizzleDb,
		private readonly runtime: Runtime,
		options?: TenantDataStoreOptions,
	) {
		this.blobStore = options?.blobStore;
		this.encryptedBlobStore = options?.encryptedBlobStore;
	}

	/** Returns the appropriate blob store based on workload encryption setting. */
	private storeFor(workloadId: WorkloadId): BlobStore | undefined {
		const row = this.db.select({ config: workloads.config }).from(workloads).where(eq(workloads.workloadId, workloadId)).get();
		const encrypt = (row?.config as Workload | undefined)?.filesystem?.encrypt_overlays ?? true;
		if (encrypt && this.encryptedBlobStore) return this.encryptedBlobStore;
		return this.blobStore;
	}

	/** Overlay key used in the blob store. */
	private overlayKey(tenantId: TenantId, workloadId: WorkloadId): string {
		return `${tenantId}/${workloadId}`;
	}

	/**
	 * Copies an overlay archive into tenant storage and records the reference
	 * on the tenant row. When a blob store is configured, also uploads to S3.
	 */
	async saveOverlay(tenantId: TenantId, workloadId: WorkloadId, overlayPath: string): Promise<void> {
		const key = this.overlayKey(tenantId, workloadId);
		const store = this.storeFor(workloadId);

		if (store) {
			await store.put(key, overlayPath);
			this.updateOverlayRef(tenantId, workloadId, key);
		} else {
			// Legacy: copy to local storage path
			const destDir = join(this.storagePath, tenantId, workloadId);
			mkdirSync(destDir, { recursive: true });
			const { copyFileSync } = await import("node:fs");
			const destPath = join(destDir, "overlay.tar.gz");
			copyFileSync(overlayPath, destPath);
			this.updateOverlayRef(tenantId, workloadId, destPath);
		}
	}

	/**
	 * Writes overlay data directly into tenant storage from a buffer
	 * (e.g. tar archive extracted from a running container).
	 */
	async saveOverlayBuffer(tenantId: TenantId, workloadId: WorkloadId, data: Buffer): Promise<void> {
		const key = this.overlayKey(tenantId, workloadId);
		const store = this.storeFor(workloadId);

		if (store) {
			await store.putBuffer(key, data);
			this.updateOverlayRef(tenantId, workloadId, key);
		} else {
			const destDir = join(this.storagePath, tenantId, workloadId);
			mkdirSync(destDir, { recursive: true });
			const destPath = join(destDir, "overlay.tar.gz");
			writeFileSync(destPath, data);
			this.updateOverlayRef(tenantId, workloadId, destPath);
		}
	}

	/**
	 * Returns the path to the stored overlay for this tenant+workload,
	 * or `null` if no overlay exists.
	 */
	async restoreOverlay(tenantId: TenantId, workloadId: WorkloadId): Promise<string | null> {
		const key = this.overlayKey(tenantId, workloadId);
		const store = this.storeFor(workloadId);

		if (store) {
			try {
				return await store.get(key);
			} catch (err) {
				if (err instanceof BlobNotFoundError) return null;
				throw err;
			}
		}

		// Legacy: check local storage
		const row = this.db
			.select({ dataOverlayRef: tenants.dataOverlayRef })
			.from(tenants)
			.where(and(eq(tenants.tenantId, tenantId), eq(tenants.workloadId, workloadId)))
			.get();

		if (!row?.dataOverlayRef) return null;
		if (!existsSync(row.dataOverlayRef)) return null;
		return row.dataOverlayRef;
	}

	/** Returns true when a stored overlay exists for this tenant+workload. */
	async hasOverlay(tenantId: TenantId, workloadId: WorkloadId): Promise<boolean> {
		const key = this.overlayKey(tenantId, workloadId);
		const store = this.storeFor(workloadId);

		if (store) {
			return store.has(key);
		}

		return (await this.restoreOverlay(tenantId, workloadId)) !== null;
	}

	/**
	 * Reads the stored overlay archive for this tenant+workload and pipes it
	 * into the instance via `tar -xz -C /`, injecting the data into the
	 * running container's filesystem.
	 *
	 * No-op if no overlay is stored for this tenant+workload.
	 */
	async injectOverlay(handle: InstanceHandle, tenantId: TenantId, workloadId: WorkloadId): Promise<void> {
		const overlayPath = await this.restoreOverlay(tenantId, workloadId);
		if (!overlayPath) return;
		const { createReadStream } = await import("node:fs");
		const stdin = createReadStream(overlayPath);
		await this.runtime.exec(handle, ["tar", "-xz", "-C", "/"], { stdin });
	}

	/**
	 * Runs `tar -cz` over the workload's overlay dirs inside the instance
	 * and saves the resulting archive to tenant storage.
	 *
	 * Freezes the container before extraction so no writes can occur
	 * mid-tar, then unfreezes (or lets the caller destroy it).
	 *
	 * Returns true if overlay data was saved, false otherwise.
	 * No-op if the workload has no overlay_dirs configured.
	 */
	async extractOverlay(handle: InstanceHandle, tenantId: TenantId, workloadId: WorkloadId): Promise<boolean> {
		const workloadRow = this.db.select().from(workloads).where(eq(workloads.workloadId, workloadId)).get();
		const overlayDirs = (workloadRow?.config as Workload | undefined)?.filesystem?.overlay_dirs;
		if (!overlayDirs?.length) return false;

		if (!this.runtime.extractOverlayArchive) return false;

		// Freeze the container so no writes occur during extraction, if supported.
		const canPause = !!(this.runtime.pause && this.runtime.unpause);
		if (canPause) {
			await this.runtime.pause!(handle);
		}

		try {
			const archive = await this.runtime.extractOverlayArchive(handle.instanceId, overlayDirs);
			if (!archive?.length) return false;
			await this.saveOverlayBuffer(tenantId, workloadId, archive);
			return true;
		} finally {
			if (canPause) {
				await this.runtime.unpause!(handle).catch(() => {});
			}
		}
	}

	private updateOverlayRef(tenantId: TenantId, workloadId: WorkloadId, ref: string): void {
		this.db
			.update(tenants)
			.set({ dataOverlayRef: ref })
			.where(and(eq(tenants.tenantId, tenantId), eq(tenants.workloadId, workloadId)))
			.run();
	}
}
