export interface DockerConfig {
	/**
	 * Path to the Docker daemon Unix socket.
	 * @default auto-detected (checks /var/run/docker.sock, ~/.docker/run/docker.sock)
	 */
	socketPath?: string;

	/**
	 * Path to an OCI seccomp profile JSON file on the host.
	 * When set, the profile is read and applied to all workload containers.
	 */
	seccompProfilePath?: string;

	/**
	 * Directory for sidecar temp files (envoy configs, certs).
	 * Must be accessible to sibling containers when running in Docker-in-Docker.
	 * @default os.tmpdir()
	 */
	sidecarTmpDir?: string;

	/**
	 * Host address used to reach managed containers' mapped ports.
	 * Set to "host.docker.internal" when running inside Docker Desktop.
	 * @default "127.0.0.1"
	 */
	endpointHost?: string;
}
