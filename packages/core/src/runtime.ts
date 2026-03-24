import { Type, type Static } from "@sinclair/typebox";
import { InstanceIdSchema } from "./types";
import type { InstanceId } from "./types";
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

/** Pool lifecycle status for a pre-warmed instance. Null means not in pool. */
export type PoolStatus = "warming" | "ready" | "acquired" | null;

/** Options for executing a command inside an instance. */
export interface ExecOptions {
	/** Optional stdin stream piped into the command. */
	stdin?: import("node:stream").Readable;
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
	/** Create a new instance from a workload definition (cold boot). */
	create(workload: Workload, instanceId: InstanceId, options?: CreateOptions): Promise<InstanceHandle>;

	/** Start a stopped/created instance. */
	start(handle: InstanceHandle): Promise<void>;

	/** Destroy an instance and clean up all resources. */
	destroy(handle: InstanceHandle): Promise<void>;

	/** Execute a command inside the instance. */
	exec(handle: InstanceHandle, command: string[], options?: ExecOptions): Promise<ExecResult>;

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
