export interface DockerConfig {
	/**
	 * Path to the Docker daemon Unix socket.
	 * @default "/var/run/docker.sock"
	 */
	socketPath?: string;

	/**
	 * Path to an OCI seccomp profile JSON file on the host.
	 * When set, the profile is read and applied to all workload containers.
	 */
	seccompProfilePath?: string;
}
