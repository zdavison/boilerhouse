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
	/** Guest ports exposed by the workload. */
	ports: Type.Array(Type.Integer({ exclusiveMinimum: 0 }), { minItems: 1 }),
});

// ── Types ────────────────────────────────────────────────────────────────────

export interface ExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

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

	/** Execute a command inside the guest VM. */
	exec(handle: InstanceHandle, command: string[]): Promise<ExecResult>;

	/** Get the guest IP / connectivity info for reaching the instance. */
	getEndpoint(handle: InstanceHandle): Promise<Endpoint>;

	/** List all instance IDs currently known to the runtime. */
	list(): Promise<InstanceId[]>;

	/** Check if the runtime is available on this host. */
	available(): Promise<boolean>;
}
