import type { ContainerCreateSpec, ContainerInspect, ExecResult, PodCreateSpec } from "./client";

/** Result of a checkpoint operation performed by a backend. */
export interface CheckpointResult {
	/** Absolute path to the stored checkpoint archive. */
	archivePath: string;
	/** Container ports extracted from the checkpoint's config.dump. */
	exposedPorts: number[];
	/** Whether the archive on disk is age-encrypted at rest. */
	encrypted?: boolean;
}

/** Result of an ensureImage operation. */
export interface EnsureImageResult {
	/** The resolved image reference. */
	image: string;
	/** What action was taken: "cached" (already present), "pulled", or "built". */
	action: "cached" | "pulled" | "built";
}

/** Backend system information. */
export interface BackendInfo {
	/** Whether CRIU is available for checkpoint/restore. */
	criuEnabled: boolean;
	/** Podman or daemon version string. */
	version: string;
	/** Host CPU architecture (e.g. "x86_64", "aarch64"). */
	architecture: string;
}

/**
 * Abstraction over container lifecycle operations.
 *
 * Implemented by `DaemonBackend`, which talks to `boilerhouse-podmand` over a Unix socket.
 */
export interface ContainerBackend {
	/** Fetch backend system information. */
	info(): Promise<BackendInfo>;

	/**
	 * Ensure the workload image is available.
	 * Pulls from registry or builds from Dockerfile as needed.
	 */
	ensureImage(
		image: { ref?: string; dockerfile?: string },
		workload: { name: string; version: string },
	): Promise<EnsureImageResult>;

	/** Create a container from a spec. Returns the container ID. */
	createContainer(spec: ContainerCreateSpec): Promise<string>;

	/** Start a container by name or ID. */
	startContainer(id: string): Promise<void>;

	/** Inspect a container. Returns the container metadata. */
	inspectContainer(id: string): Promise<ContainerInspect>;

	/** Force remove a container. Idempotent. */
	removeContainer(id: string): Promise<void>;

	/**
	 * Checkpoint a container and store the archive.
	 * Handles archive rewriting, HMAC signing, and file I/O.
	 */
	checkpoint(
		id: string,
		archiveDir: string,
	): Promise<CheckpointResult>;

	/**
	 * Restore a container from a checkpoint archive.
	 *
	 * @param pod - Optional pod name to restore the container into.
	 * @param encrypted - Whether the archive on disk is age-encrypted.
	 * @returns The new container ID.
	 */
	restore(
		archivePath: string,
		name: string,
		publishPorts?: string[],
		pod?: string,
		encrypted?: boolean,
	): Promise<string>;

	/**
	 * Execute a command inside a running container.
	 */
	exec(id: string, cmd: string[]): Promise<ExecResult>;

	/**
	 * List container IDs managed by this backend.
	 */
	listContainers(): Promise<string[]>;

	/**
	 * Fetch recent stdout/stderr logs from a container.
	 *
	 * @param tail - Number of most recent lines to return.
	 */
	logs(id: string, tail?: number): Promise<string>;

	// ── Pod operations ──────────────────────────────────────────────────────

	/**
	 * Create a podman pod. Containers in the pod share a network namespace.
	 * Returns the host ports assigned to the pod (dynamically allocated at creation time).
	 */
	createPod(name: string, spec?: PodCreateSpec): Promise<{ hostPorts: number[] }>;

	/** Start all containers in a pod. */
	startPod(name: string): Promise<void>;

	/** Inspect a pod. Returns the infra container ID for port resolution. */
	inspectPod(name: string): Promise<{ infraContainerId: string }>;

	/** Force remove a pod and all its containers. Idempotent. */
	removePod(name: string): Promise<void>;

	// ── File operations ─────────────────────────────────────────────────────

	/**
	 * Write a file to a daemon-managed directory. Returns the absolute
	 * path where the file was written (for bind-mounting into containers).
	 */
	writeFile(name: string, content: string): Promise<string>;

	/** Remove a file previously written via writeFile. Idempotent. */
	removeFile(name: string): Promise<void>;
}
