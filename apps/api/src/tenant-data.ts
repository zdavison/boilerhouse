import { mkdirSync, copyFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { eq, and } from "drizzle-orm";
import type { TenantId, WorkloadId, Runtime, InstanceHandle, Workload } from "@boilerhouse/core";
import type { DrizzleDb } from "@boilerhouse/db";
import { tenants, workloads } from "@boilerhouse/db";

export class TenantDataStore {
	constructor(
		private readonly storagePath: string,
		private readonly db: DrizzleDb,
		private readonly runtime: Runtime,
	) {}

	/**
	 * Copies an overlay archive into tenant storage and records the reference
	 * on the tenant row.
	 */
	saveOverlay(tenantId: TenantId, workloadId: WorkloadId, overlayPath: string): void {
		const destDir = join(this.storagePath, tenantId, workloadId);
		mkdirSync(destDir, { recursive: true });

		const destPath = join(destDir, "overlay.tar.gz");
		copyFileSync(overlayPath, destPath);

		this.db
			.update(tenants)
			.set({ dataOverlayRef: destPath })
			.where(and(eq(tenants.tenantId, tenantId), eq(tenants.workloadId, workloadId)))
			.run();
	}

	/**
	 * Writes overlay data directly into tenant storage from a buffer
	 * (e.g. tar archive extracted from a running container).
	 */
	saveOverlayBuffer(tenantId: TenantId, workloadId: WorkloadId, data: Buffer): void {
		const destDir = join(this.storagePath, tenantId, workloadId);
		mkdirSync(destDir, { recursive: true });

		const destPath = join(destDir, "overlay.tar.gz");
		writeFileSync(destPath, data);

		this.db
			.update(tenants)
			.set({ dataOverlayRef: destPath })
			.where(and(eq(tenants.tenantId, tenantId), eq(tenants.workloadId, workloadId)))
			.run();
	}

	/**
	 * Returns the path to the stored overlay for this tenant+workload,
	 * or `null` if no overlay exists.
	 */
	restoreOverlay(tenantId: TenantId, workloadId: WorkloadId): string | null {
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
	hasOverlay(tenantId: TenantId, workloadId: WorkloadId): boolean {
		return this.restoreOverlay(tenantId, workloadId) !== null;
	}

	/**
	 * Reads the stored overlay archive for this tenant+workload and pipes it
	 * into the instance via `tar -xz -C /`, injecting the data into the
	 * running container's filesystem.
	 *
	 * No-op if no overlay is stored for this tenant+workload.
	 */
	async injectOverlay(handle: InstanceHandle, tenantId: TenantId, workloadId: WorkloadId): Promise<void> {
		const overlayPath = this.restoreOverlay(tenantId, workloadId);
		if (!overlayPath) return;
		const { createReadStream } = await import("node:fs");
		const stdin = createReadStream(overlayPath);
		await this.runtime.exec(handle, ["tar", "-xz", "-C", "/"], { stdin });
	}

	/**
	 * Runs `tar -cz` over the workload's overlay dirs inside the instance
	 * and saves the resulting archive to tenant storage.
	 *
	 * No-op if the workload has no overlay_dirs configured.
	 */
	async extractOverlay(handle: InstanceHandle, tenantId: TenantId, workloadId: WorkloadId): Promise<void> {
		const workloadRow = this.db.select().from(workloads).where(eq(workloads.workloadId, workloadId)).get();
		const overlayDirs = (workloadRow?.config as Workload | undefined)?.filesystem?.overlay_dirs;
		if (!overlayDirs?.length) return;
		const result = await this.runtime.exec(handle, ["tar", "-cz", ...overlayDirs]);
		this.saveOverlayBuffer(tenantId, workloadId, Buffer.from(result.stdout));
	}
}
