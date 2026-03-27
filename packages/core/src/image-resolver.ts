/**
 * Abstraction for ensuring container images are available before instance creation.
 * Each runtime environment (Docker daemon, minikube, remote registry) implements
 * this interface to handle pull/build/cache logic.
 */
export interface ImageResolveResult {
	/** The resolved image reference to use when creating the container. */
	imageRef: string;
	/** Whether the image was built locally (e.g. minikube) and needs imagePullPolicy: Never. */
	localBuild: boolean;
}

export interface ImageSpec {
	/** Registry image reference (e.g. "alpine:3.21"). Mutually exclusive with dockerfile. */
	ref?: string;
	/** Path to a Dockerfile for local builds. Mutually exclusive with ref. */
	dockerfile?: string;
}

export interface WorkloadMeta {
	name: string;
	version: string;
}

export interface ImageResolver {
	/**
	 * Ensures the image described by `image` is available to the runtime.
	 * Pulls from a registry, builds from a Dockerfile, or returns a cached reference.
	 */
	ensure(
		image: ImageSpec,
		workload: WorkloadMeta,
		log: (line: string) => void,
	): Promise<ImageResolveResult>;
}
