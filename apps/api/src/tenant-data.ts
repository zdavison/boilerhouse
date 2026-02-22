import { mkdirSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { TenantId, WorkloadId } from "@boilerhouse/core";
import type { DrizzleDb } from "@boilerhouse/db";
import { tenants } from "@boilerhouse/db";

export class TenantDataStore {
	constructor(
		private readonly storagePath: string,
		private readonly db: DrizzleDb,
	) {}

	/**
	 * Copies an overlay file into tenant storage and records the reference
	 * on the tenant row.
	 */
	saveOverlay(tenantId: TenantId, workloadId: WorkloadId, overlayPath: string): void {
		const destDir = join(this.storagePath, tenantId, workloadId);
		mkdirSync(destDir, { recursive: true });

		const destPath = join(destDir, "overlay.ext4");
		copyFileSync(overlayPath, destPath);

		this.db
			.update(tenants)
			.set({ dataOverlayRef: destPath })
			.where(eq(tenants.tenantId, tenantId))
			.run();
	}

	/**
	 * Returns the path to the stored overlay for this tenant+workload,
	 * or `null` if no overlay exists.
	 */
	restoreOverlay(tenantId: TenantId): string | null {
		const row = this.db
			.select({ dataOverlayRef: tenants.dataOverlayRef })
			.from(tenants)
			.where(eq(tenants.tenantId, tenantId))
			.get();

		if (!row?.dataOverlayRef) return null;

		if (!existsSync(row.dataOverlayRef)) return null;

		return row.dataOverlayRef;
	}
}
