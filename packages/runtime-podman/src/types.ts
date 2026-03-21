export interface PodmanConfig {
	/**
	 * Directory for storing checkpoint archives.
	 * @default "/var/lib/boilerhouse/snapshots"
	 * @example "/data/snapshots"
	 */
	snapshotDir: string;

	/**
	 * Path to the `boilerhouse-podmand` runtime socket.
	 * @default DEFAULT_RUNTIME_SOCKET (platform-dependent, see @boilerhouse/core paths.ts)
	 */
	socketPath?: string;

	/**
	 * Path to an OCI seccomp profile JSON file accessible by Podman.
	 * When set, containers are created with this custom seccomp profile.
	 * When omitted, Podman's built-in default seccomp profile is used.
	 *
	 * Note: on macOS with Podman Machine, this path must exist inside
	 * the Linux VM, not on the macOS host.
	 */
	seccompProfilePath?: string;
}
