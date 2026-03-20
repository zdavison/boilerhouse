import { Type, type Static } from "@sinclair/typebox";
import { InstanceIdSchema } from "./types";
import type { InstanceId } from "./types";
import type { SnapshotRef } from "./snapshot";
import type { Workload } from "./workload";

// ── Schemas ──────────────────────────────────────────────────────────────────

export const InstanceHandleSchema = Type.Object({
	/** The unique instance identifier. */
	instanceId: InstanceIdSchema,
	/** Whether the instance is currently running. */
	running: Type.Boolean(),
	/** Runtime-specific metadata exposed to consumers. */
	meta: Type.Optional(Type.Record(Type.String(), Type.String())),
});

export const EndpointSchema = Type.Object({
	host: Type.String({ minLength: 1 }),
	/** Host-mapped ports exposed by the workload. Empty for no-network containers. */
	ports: Type.Array(Type.Integer({ exclusiveMinimum: 0 })),
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
	/** Whether the instance is currently running. */
	running: boolean;
	/** Runtime-specific metadata exposed to consumers. */
	meta?: Record<string, string>;
}

export type Endpoint = Static<typeof EndpointSchema>;

// ── Runtime capabilities ─────────────────────────────────────────────────────

export interface RuntimeCapabilities {
	/**
	 * Whether the runtime supports golden snapshots (CRIU checkpoint/restore).
	 * When false, workloads skip golden snapshot creation and go straight to
	 * "ready". Claim always cold-boots; release always destroys after snapshot.
	 */
	goldenSnapshots: boolean;
}

// ── Create options ──────────────────────────────────────────────────────────

export interface CreateOptions {
	/**
	 * Serialised Envoy bootstrap config JSON. When provided, the runtime
	 * creates an Envoy sidecar proxy alongside the workload container.
	 * The sidecar enforces domain allowlisting and injects credential headers.
	 */
	proxyConfig?: string;
	/** Optional log callback for progress messages during creation. */
	onLog?: (line: string) => void;
}

// ── Runtime interface ────────────────────────────────────────────────────────

export interface Runtime {
	readonly capabilities: RuntimeCapabilities;
	/** Create a new instance from a workload definition (cold boot). */
	create(workload: Workload, instanceId: InstanceId, options?: CreateOptions): Promise<InstanceHandle>;

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
	 *
	 * @param options - Optional create options (e.g. proxyConfig for sidecar).
	 */
	restore(ref: SnapshotRef, instanceId: InstanceId, options?: CreateOptions): Promise<InstanceHandle>;

	/** Execute a command inside the instance. */
	exec(handle: InstanceHandle, command: string[]): Promise<ExecResult>;

	/** Get the connectivity info for reaching the instance. */
	getEndpoint(handle: InstanceHandle): Promise<Endpoint>;

	/** List all instance IDs currently known to the runtime. */
	list(): Promise<InstanceId[]>;

	/**
	 * Fetch recent stdout/stderr logs from a running instance.
	 * Returns null if the runtime doesn't support log retrieval.
	 */
	logs?(handle: InstanceHandle, tail?: number): Promise<string | null>;

	/** Check if the runtime is available on this host. */
	available(): Promise<boolean>;
}
