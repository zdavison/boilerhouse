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
	 * Serialised Envoy bootstrap config YAML. When provided, the runtime
	 * creates an Envoy sidecar proxy alongside the workload container.
	 * The sidecar enforces domain allowlisting and injects credential headers.
	 */
	proxyConfig?: string;
	/** PEM CA cert for the workload to trust (for MITM TLS interception). */
	proxyCaCert?: string;
	/** Per-domain TLS certs for Envoy to serve (MITM). */
	proxyCerts?: Array<{ domain: string; cert: string; key: string }>;
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

	/**
	 * Upload a tar archive into a container's filesystem.
	 * Works on created-but-not-started containers (for pre-start overlay injection).
	 * Optional — only implemented by runtimes that support it.
	 */
	injectArchive?(instanceId: InstanceId, destPath: string, tar: Buffer): Promise<void>;

	/** Freeze all processes in a running instance (cgroups pause). Optional. */
	pause?(handle: InstanceHandle): Promise<void>;

	/** Unfreeze a paused instance. Optional. */
	unpause?(handle: InstanceHandle): Promise<void>;

	/**
	 * Extract overlay directories as a tar.gz archive from the host side.
	 * Works on paused containers (unlike exec). Returns null if not supported
	 * or no overlay data exists.
	 */
	extractOverlayArchive?(instanceId: InstanceId, overlayDirs: string[]): Promise<Buffer | null>;

	/** Restart a running instance (stop + start). Optional. */
	restart?(handle: InstanceHandle): Promise<void>;

	/**
	 * Returns the latest mtime across all files in the given overlay directories.
	 * Used for filesystem-activity-based idle detection.
	 *
	 * Returns `null` if the check fails (container unreachable, etc.).
	 * Returns `new Date(0)` if directories exist but are empty.
	 */
	statOverlayDirs?(instanceId: InstanceId, handle: InstanceHandle, dirs: string[]): Promise<Date | null>;

	/** Get resource usage stats for a running container. Optional. */
	stats?(handle: InstanceHandle): Promise<ContainerResourceStats | null>;

	/** Check if the runtime is available on this host. */
	available(): Promise<boolean>;
}

/** Resource usage snapshot for a single container. */
export interface ContainerResourceStats {
	/** CPU usage as a fraction (0.0–N where N = number of CPUs). */
	cpuFraction: number;
	/** Memory usage in bytes. */
	memoryBytes: number;
	/** Memory limit in bytes. */
	memoryLimitBytes: number;
}
