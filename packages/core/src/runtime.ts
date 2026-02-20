import { Type, type Static } from "@sinclair/typebox";
import { InstanceIdSchema } from "./types";
import type { InstanceId } from "./types";
import type { SnapshotRef } from "./snapshot";
import type { Workload } from "./workload";

// ── Schemas ──────────────────────────────────────────────────────────────────

export const InstanceHandleSchema = Type.Object({
	/** The unique instance identifier. */
	instanceId: InstanceIdSchema,
	/** Whether the VM is currently running. */
	running: Type.Boolean(),
});

export const EndpointSchema = Type.Object({
	host: Type.String({ minLength: 1 }),
	port: Type.Integer({ exclusiveMinimum: 0 }),
});

// ── Types ────────────────────────────────────────────────────────────────────

export interface InstanceHandle {
	/** The unique instance identifier. */
	instanceId: InstanceId;
	/** Whether the VM is currently running. */
	running: boolean;
}

export type Endpoint = Static<typeof EndpointSchema>;

// ── Runtime interface ────────────────────────────────────────────────────────

export interface Runtime {
	/** Create a new microVM from a workload definition (cold boot). */
	create(workload: Workload, instanceId: InstanceId): Promise<InstanceHandle>;

	/** Start a stopped/created instance. */
	start(handle: InstanceHandle): Promise<void>;

	/** Stop a running instance gracefully. */
	stop(handle: InstanceHandle): Promise<void>;

	/** Destroy an instance and clean up all resources. */
	destroy(handle: InstanceHandle): Promise<void>;

	/**
	 * Create a snapshot of a running instance.
	 * Returns a reference that can be passed to `restore()`.
	 */
	snapshot(handle: InstanceHandle): Promise<SnapshotRef>;

	/**
	 * Restore an instance from a snapshot.
	 * Returns a running instance handle.
	 */
	restore(ref: SnapshotRef, instanceId: InstanceId): Promise<InstanceHandle>;

	/** Get the guest IP / connectivity info for reaching the instance. */
	getEndpoint(handle: InstanceHandle): Promise<Endpoint>;

	/** Check if the runtime is available on this host. */
	available(): Promise<boolean>;
}
