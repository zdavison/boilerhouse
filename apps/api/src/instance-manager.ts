import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import type {
	Runtime,
	InstanceHandle,
	InstanceId,
	WorkloadId,
	NodeId,
	TenantId,
	SnapshotRef,
	Workload,
	Endpoint,
	CreateOptions,
} from "@boilerhouse/core";
import { generateInstanceId, canTransition, InvalidTransitionError } from "@boilerhouse/core";
import type { DrizzleDb, ActivityLog } from "@boilerhouse/db";
import { instances, snapshots, tenants, workloads } from "@boilerhouse/db";
import {
	applyInstanceTransition,
	applySnapshotTransition,
	applyTenantTransition,
} from "./transitions";
import type { Logger } from "@boilerhouse/o11y";
import type { EventBus } from "./event-bus";
import type { SecretStore } from "./secret-store";
import { generateEnvoyConfig } from "@boilerhouse/envoy-config";
import type { CredentialRule } from "@boilerhouse/envoy-config";

/** Derives an InstanceHandle from a DB row's status. */
export function instanceHandleFrom(instanceId: InstanceId, status: string): InstanceHandle {
	return { instanceId, running: status === "active" };
}

export class SnapshotNotFoundError extends Error {
	constructor(snapshotId: string) {
		super(`Snapshot not found: ${snapshotId}`);
		this.name = "SnapshotNotFoundError";
	}
}

export class InstanceManager {
	constructor(
		private readonly runtime: Runtime,
		private readonly db: DrizzleDb,
		private readonly activityLog: ActivityLog,
		private readonly nodeId: NodeId,
		private readonly eventBus?: EventBus,
		private readonly log?: Logger,
		private readonly secretStore?: SecretStore,
	) {}

	async create(
		workloadId: WorkloadId,
		workload: Workload,
		tenantId?: TenantId,
	): Promise<InstanceHandle> {
		const instanceId = generateInstanceId();

		this.db
			.insert(instances)
			.values({
				instanceId,
				workloadId,
				nodeId: this.nodeId,
				tenantId: tenantId ?? null,
				status: "starting",
				createdAt: new Date(),
			})
			.run();

		try {
			const createOptions = this.buildCreateOptions(workload, tenantId);
			const handle = await this.runtime.create(workload, instanceId, createOptions);
			await this.runtime.start(handle);

			applyInstanceTransition(this.db, instanceId, "starting", "started");

			this.activityLog.log({
				event: "instance.created",
				instanceId,
				workloadId,
				nodeId: this.nodeId,
			});

			return handle;
		} catch (err) {
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

		await this.runtime.destroy(handle);

		applyInstanceTransition(this.db, instanceId, "destroying", "destroyed");

		if (row.tenantId) {
			const tenantRow = this.db
				.select({ status: tenants.status })
				.from(tenants)
				.where(eq(tenants.tenantId, row.tenantId))
				.get();

			if (tenantRow?.status === "active") {
				applyTenantTransition(this.db, row.tenantId, "active", "release");
				applyTenantTransition(this.db, row.tenantId, "releasing", "destroyed");

				this.db
					.update(tenants)
					.set({ instanceId: null })
					.where(eq(tenants.tenantId, row.tenantId))
					.run();
			}
		}

		this.activityLog.log({
			event: "instance.destroyed",
			instanceId,
			nodeId: this.nodeId,
			workloadId: row.workloadId,
			tenantId: row.tenantId,
		});

		this.eventBus?.emit({
			type: "instance.state",
			instanceId,
			status: "destroyed",
			workloadId: row.workloadId,
			tenantId: row.tenantId ?? undefined,
		});
	}

	async hibernate(instanceId: InstanceId): Promise<SnapshotRef> {
		const row = this.db
			.select()
			.from(instances)
			.where(eq(instances.instanceId, instanceId))
			.get();

		if (!row) {
			throw new Error(`Instance not found: ${instanceId}`);
		}

		if (!canTransition(row.status, "hibernate")) {
			throw new InvalidTransitionError("instance", row.status, "hibernate");
		}

		const handle = instanceHandleFrom(instanceId, row.status);

		let ref: SnapshotRef;
		try {
			ref = await this.runtime.snapshot(handle);
		} catch (err) {
			await this.destroy(instanceId);
			throw err;
		}

		// Use the instance row's workloadId/nodeId for FK integrity
		const correctedRef: SnapshotRef = {
			...ref,
			workloadId: row.workloadId,
			nodeId: this.nodeId,
		};

		this.db
			.insert(snapshots)
			.values({
				snapshotId: correctedRef.id,
				type: correctedRef.type,
				status: "creating",
				instanceId,
				tenantId: row.tenantId,
				workloadId: row.workloadId,
				nodeId: this.nodeId,
				vmstatePath: correctedRef.paths.vmstate,
				memoryPath: correctedRef.paths.memory,
				encrypted: correctedRef.encrypted ?? false,
				sizeBytes: 0,
				runtimeMeta: correctedRef.runtimeMeta as Record<string, unknown>,
				createdAt: new Date(),
			})
			.run();

		applySnapshotTransition(this.db, correctedRef.id, "creating", "created");

		await this.runtime.destroy(handle);

		applyInstanceTransition(this.db, instanceId, row.status, "hibernate");

		if (row.tenantId) {
			// Delete the previous tenant snapshot (keep only the latest)
			const tenantRow = this.db
				.select({ lastSnapshotId: tenants.lastSnapshotId, status: tenants.status })
				.from(tenants)
				.where(eq(tenants.tenantId, row.tenantId))
				.get();

			if (tenantRow?.lastSnapshotId) {
				this.db
					.delete(snapshots)
					.where(eq(snapshots.snapshotId, tenantRow.lastSnapshotId))
					.run();
			}

			this.db
				.update(tenants)
				.set({ lastSnapshotId: correctedRef.id })
				.where(eq(tenants.tenantId, row.tenantId))
				.run();

			// If tenant is still "active", this hibernate was called directly
			// (not through the tenant release flow). Transition the tenant to
			// "released" and clear its instanceId so it can be re-claimed.
			if (tenantRow?.status === "active") {
				applyTenantTransition(this.db, row.tenantId, "active", "release");
				applyTenantTransition(this.db, row.tenantId, "releasing", "hibernated");

				this.db
					.update(tenants)
					.set({ instanceId: null })
					.where(eq(tenants.tenantId, row.tenantId))
					.run();
			}
		}

		this.activityLog.log({
			event: "instance.hibernated",
			instanceId,
			nodeId: this.nodeId,
			workloadId: row.workloadId,
			tenantId: row.tenantId,
			metadata: { snapshotId: correctedRef.id },
		});

		this.eventBus?.emit({
			type: "instance.state",
			instanceId,
			status: "hibernated",
			workloadId: row.workloadId,
			tenantId: row.tenantId ?? undefined,
		});

		return correctedRef;
	}

	async restoreFromSnapshot(
		ref: SnapshotRef,
		tenantId: TenantId,
	): Promise<InstanceHandle> {
		// Verify the snapshot exists in the DB
		const snapshotRow = this.db
			.select()
			.from(snapshots)
			.where(eq(snapshots.snapshotId, ref.id))
			.get();

		if (!snapshotRow) {
			throw new SnapshotNotFoundError(ref.id);
		}

		const instanceId = generateInstanceId();

		this.log?.info(
			{ snapshotId: ref.id, snapshotType: ref.type, instanceId, tenantId },
			"Restoring instance from snapshot",
		);

		this.db
			.insert(instances)
			.values({
				instanceId,
				workloadId: snapshotRow.workloadId,
				nodeId: this.nodeId,
				tenantId,
				status: "starting",
				createdAt: new Date(),
			})
			.run();

		// Build proxy config for the restored instance
		const workloadRow = this.db
			.select({ config: workloads.config })
			.from(workloads)
			.where(eq(workloads.workloadId, snapshotRow.workloadId))
			.get();

		const restoreOptions = workloadRow
			? this.buildCreateOptions(workloadRow.config as Workload, tenantId)
			: undefined;

		let handle: InstanceHandle;
		try {
			handle = await this.runtime.restore(ref, instanceId, restoreOptions);
		} catch (err) {
			this.log?.error(
				{ snapshotId: ref.id, instanceId, tenantId, err },
				"Failed to restore instance from snapshot",
			);
			throw err;
		}

		applyInstanceTransition(this.db, instanceId, "starting", "started");

		this.log?.info(
			{ instanceId, tenantId, snapshotId: ref.id },
			"Instance restored successfully",
		);

		this.activityLog.log({
			event: "instance.restored",
			instanceId,
			nodeId: this.nodeId,
			workloadId: snapshotRow.workloadId,
			tenantId,
			metadata: {
				snapshotType: ref.type,
				snapshotId: ref.id,
			},
		});

		return handle;
	}

	// ── Overlay helpers ─────────────────────────────────────────────────────

	/**
	 * Extracts overlay directories from a running instance as a tar.gz archive.
	 * Returns null if the extraction fails or produces no data.
	 */
	async extractOverlay(instanceId: InstanceId, overlayDirs: string[]): Promise<Buffer | null> {
		if (overlayDirs.length === 0) return null;

		const row = this.db
			.select({ status: instances.status })
			.from(instances)
			.where(eq(instances.instanceId, instanceId))
			.get();

		if (!row) return null;

		const handle = instanceHandleFrom(instanceId, row.status);
		const dirs = overlayDirs.map((d) => `'${d}'`).join(" ");
		const result = await this.runtime.exec(handle, [
			"sh", "-c", `tar czf - ${dirs} 2>/dev/null | base64`,
		]);

		if (result.exitCode !== 0 || !result.stdout.trim()) return null;

		return Buffer.from(result.stdout.trim(), "base64");
	}

	/**
	 * Injects a tar.gz overlay archive into a running instance by extracting
	 * it at the root filesystem.
	 */
	async injectOverlay(instanceId: InstanceId, overlayArchivePath: string): Promise<void> {
		const row = this.db
			.select({ status: instances.status })
			.from(instances)
			.where(eq(instances.instanceId, instanceId))
			.get();

		if (!row) {
			throw new Error(`Instance not found: ${instanceId}`);
		}

		const handle = instanceHandleFrom(instanceId, row.status);
		const overlayData = readFileSync(overlayArchivePath);
		const b64 = overlayData.toString("base64");

		const result = await this.runtime.exec(handle, [
			"sh", "-c", `echo '${b64}' | base64 -d | tar xzf - -C /`,
		]);

		if (result.exitCode !== 0) {
			this.log?.error(
				{ instanceId, stderr: result.stderr },
				"Failed to inject overlay data",
			);
			throw new Error(`Overlay injection failed: ${result.stderr}`);
		}
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
		if (workload.network.access !== "restricted" || !this.secretStore) {
			return undefined;
		}

		const allowlist = workload.network.allowlist ?? [];

		let credentials: CredentialRule[] | undefined;
		if (workload.network.credentials && workload.network.credentials.length > 0) {
			credentials = workload.network.credentials.map((cred) => {
				const resolvedHeaders: Record<string, string> = {};
				for (const [key, template] of Object.entries(cred.headers)) {
					resolvedHeaders[key] = this.secretStore!.resolveSecretRefs(
						tenantId ?? ("" as TenantId),
						template,
					);
				}
				return { domain: cred.domain, headers: resolvedHeaders };
			});
		}

		const proxyConfig = generateEnvoyConfig({ allowlist, credentials });

		return { proxyConfig };
	}
}
