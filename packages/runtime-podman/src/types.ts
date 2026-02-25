export interface PodmanConfig {
	/**
	 * Directory for storing checkpoint archives.
	 * @default "/var/lib/boilerhouse/snapshots"
	 * @example "/data/snapshots"
	 */
	snapshotDir: string;

	/**
	 * Path to the rootful podman API socket.
	 * @default "/run/boilerhouse/podman.sock"
	 * @example "/run/podman/podman.sock"
	 */
	socketPath?: string;
}
