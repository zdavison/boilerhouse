import { eq } from "drizzle-orm";
import type {
	Runtime,
	InstanceHandle,
	InstanceId,
	WorkloadId,
	NodeId,
	TenantId,
	Workload,
	Endpoint,
	CreateOptions,
} from "@boilerhouse/core";
import { generateInstanceId } from "@boilerhouse/core";
import type { DrizzleDb } from "@boilerhouse/db";
import { instances, claims as claimsTable } from "@boilerhouse/db";
import {
	applyInstanceTransition,
	instanceHandleFrom,
} from "./transitions";
import type { Logger } from "@boilerhouse/o11y";
import type { AuditLogger } from "./audit-logger";
import type { SecretStore } from "./secret-store";
import { buildProxyCreateOptions } from "./proxy/config";

export { instanceHandleFrom } from "./transitions";

export class InstanceManager {
	constructor(
		private readonly runtime: Runtime,
		private readonly db: DrizzleDb,
		private readonly audit: AuditLogger,
		private readonly nodeId: NodeId,
		private readonly log?: Logger,
		private readonly secretStore?: SecretStore,
	) {}

	async create(
		workloadId: WorkloadId,
		workload: Workload,
		tenantId?: TenantId,
		opts?: {
			overlayArchivePath?: string;
			/** Set to "warming" when creating a pool instance. */
			poolStatus?: "warming";
			/** Log callback forwarded to the runtime (e.g. for bootstrap log capture). */
			onLog?: (line: string) => void;
		},
	): Promise<InstanceHandle> {
		const instanceId = generateInstanceId();
		const createOptions = this.buildCreateOptions(workload, tenantId);
		const hasSidecar = !!(createOptions?.proxyConfig);
		const runtimeOptions = opts?.onLog
			? { ...createOptions, onLog: opts.onLog }
			: createOptions;

		this.db
			.insert(instances)
			.values({
				instanceId,
				workloadId,
				nodeId: this.nodeId,
				tenantId: tenantId ?? null,
				status: "starting",
				poolStatus: opts?.poolStatus ?? null,
				runtimeMeta: hasSidecar ? { hasSidecar: true } : null,
				createdAt: new Date(),
			})
			.run();

		this.audit.instanceStarting(instanceId, workloadId, tenantId);

		const createStart = performance.now();
		try {
			const handle = await this.runtime.create(workload, instanceId, runtimeOptions);

			// Inject overlay data before starting so the process sees it immediately
			if (opts?.overlayArchivePath && this.runtime.injectArchive) {
				const { readFileSync } = await import("node:fs");
				const data = readFileSync(opts.overlayArchivePath);
				await this.runtime.injectArchive(instanceId, "/", data);
			}

			await this.runtime.start(handle);

			applyInstanceTransition(this.db, instanceId, "starting", "started");

			this.audit.instanceCreated(instanceId, workloadId, Math.round(performance.now() - createStart), tenantId);

			return handle;
		} catch (err) {
			this.audit.instanceError(instanceId, workloadId, err instanceof Error ? err.message : String(err), tenantId);
			this.db
				.delete(instances)
				.where(eq(instances.instanceId, instanceId))
				.run();
			throw err;
		}
	}

	async destroy(instanceId: InstanceId): Promise<void> {
		const row = this.db
			.select()
			.from(instances)
			.where(eq(instances.instanceId, instanceId))
			.get();

		if (!row) return;

		const handle = instanceHandleFrom(instanceId, row.status);

		applyInstanceTransition(this.db, instanceId, row.status, "destroy");

		const destroyStart = performance.now();
		await this.runtime.destroy(handle);

		applyInstanceTransition(this.db, instanceId, "destroying", "destroyed");

		// Clear pool marker so destroyed instances are not counted in pool queries
		this.db.update(instances).set({ poolStatus: null }).where(eq(instances.instanceId, instanceId)).run();

		// Clean up claim if this instance was claimed
		this.db.delete(claimsTable).where(eq(claimsTable.instanceId, instanceId)).run();

		this.audit.instanceDestroyed(instanceId, row.workloadId, Math.round(performance.now() - destroyStart), row.tenantId ?? undefined);
	}

	/**
	 * Hibernate an instance: extract overlay data, stop the container,
	 * and transition to "hibernated". The container is destroyed but the
	 * instance row persists with status "hibernated" so tenant data can
	 * be restored on re-claim.
	 */
	async hibernate(instanceId: InstanceId): Promise<void> {
		const row = this.db
			.select()
			.from(instances)
			.where(eq(instances.instanceId, instanceId))
			.get();

		if (!row) return;

		const handle = instanceHandleFrom(instanceId, row.status);

		applyInstanceTransition(this.db, instanceId, row.status, "hibernate");

		try {
			await this.runtime.destroy(handle);
		} catch (err) {
			applyInstanceTransition(this.db, instanceId, "hibernating", "hibernating_failed");
			// hibernating_failed → destroying; complete the destroy
			applyInstanceTransition(this.db, instanceId, "destroying", "destroyed");
			throw err;
		}

		applyInstanceTransition(this.db, instanceId, "hibernating", "hibernated");

		this.audit.instanceHibernated(instanceId, row.workloadId, row.tenantId ?? undefined);
	}

	/**
	 * Restart a running instance. Used after overlay injection into a
	 * pool instance so the process re-reads persisted state.
	 */
	async restart(instanceId: InstanceId): Promise<void> {
		if (!this.runtime.restart) return;

		const row = this.db
			.select({ status: instances.status })
			.from(instances)
			.where(eq(instances.instanceId, instanceId))
			.get();

		if (!row) return;

		const handle = instanceHandleFrom(instanceId, row.status);
		await this.runtime.restart(handle);
	}

	/**
	 * Returns the latest mtime across all files in the given directories.
	 * Delegates to the runtime's `statOverlayDirs` method.
	 *
	 * Returns `null` if the check fails (instance not found, container unreachable, etc.).
	 * Returns `new Date(0)` if directories exist but are empty.
	 */
	async statWatchDirs(instanceId: InstanceId, dirs: string[]): Promise<Date | null> {
		if (dirs.length === 0) return null;
		if (!this.runtime.statOverlayDirs) return null;

		const row = this.db
			.select({ status: instances.status })
			.from(instances)
			.where(eq(instances.instanceId, instanceId))
			.get();

		if (!row) return null;

		const handle = instanceHandleFrom(instanceId, row.status);
		return this.runtime.statOverlayDirs(instanceId, handle, dirs);
	}

	async getEndpoint(handle: InstanceHandle): Promise<Endpoint> {
		return this.runtime.getEndpoint(handle);
	}

	// ── Proxy config helpers ────────────────────────────────────────────────

	/**
	 * Build CreateOptions including Envoy sidecar proxy config if the
	 * workload has restricted network access with credentials.
	 */
	private buildCreateOptions(
		workload: Workload,
		tenantId?: TenantId,
	): CreateOptions | undefined {
		return buildProxyCreateOptions(workload, this.secretStore, tenantId);
	}
}
