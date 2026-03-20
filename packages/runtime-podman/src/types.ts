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
}
