import { resolve, dirname, basename } from "node:path";
import type { ImageResolver, ImageResolveResult, ImageSpec, WorkloadMeta } from "@boilerhouse/core";
import { KubernetesRuntimeError } from "./errors";

/** @deprecated Use ImageResolveResult from @boilerhouse/core instead. */
export type EnsureImageResult = ImageResolveResult;

/**
 * Provides image management for a minikube cluster.
 *
 * Handles pulling registry images and building Dockerfile-based images
 * directly into minikube's container runtime via `minikube image` commands.
 *
 * This is for local development only. On a real cluster, all images
 * should be pre-built and available in a registry via `image.ref`.
 */
export class MinikubeImageProvider implements ImageResolver {
	constructor(
		private readonly profile: string,
		private readonly workloadsDir?: string,
	) {}

	async ensure(
		image: ImageSpec,
		workload: WorkloadMeta,
		log: (line: string) => void,
	): Promise<ImageResolveResult> {
		return this.ensureImage(image, workload, log);
	}

	/**
	 * Ensures an image is available in minikube's container runtime.
	 *
	 * - `image.ref`: Pulls from registry if not already cached.
	 * - `image.dockerfile`: Builds via `minikube image build` if not cached.
	 *   Logs a warning that this only works locally.
	 */
	async ensureImage(
		image: { ref?: string; dockerfile?: string },
		workload: { name: string; version: string },
		log: (line: string) => void,
	): Promise<ImageResolveResult> {
		if (image.ref) {
			return this.ensureRef(image.ref, log);
		}

		if (image.dockerfile) {
			return this.ensureDockerfile(image.dockerfile, workload, log);
		}

		throw new KubernetesRuntimeError(
			`Workload "${workload.name}" has no image ref or dockerfile`,
		);
	}

	private async ensureRef(
		ref: string,
		log: (line: string) => void,
	): Promise<EnsureImageResult> {
		const images = await this.imageList();
		if (images.includes(ref)) {
			log(`Image cached: ${ref}`);
			return { imageRef: ref, localBuild: false };
		}

		log(`Pulling image ${ref} into minikube...`);
		await this.run(
			["minikube", "-p", this.profile, "image", "pull", ref],
			`Failed to pull image ${ref} into minikube`,
		);
		log(`Image pulled: ${ref}`);
		return { imageRef: ref, localBuild: false };
	}

	private async ensureDockerfile(
		dockerfile: string,
		workload: { name: string; version: string },
		log: (line: string) => void,
	): Promise<EnsureImageResult> {
		const tag = `boilerhouse/${workload.name}:${workload.version}`;

		const images = await this.imageList();
		if (images.includes(tag)) {
			log(`Image cached: ${tag}`);
			return { imageRef: tag, localBuild: true };
		}

		const dockerfilePath = this.workloadsDir
			? resolve(this.workloadsDir, dockerfile)
			: resolve(dockerfile);
		const contextDir = dirname(dockerfilePath);
		const dockerfileName = basename(dockerfilePath);

		log(`Building image ${tag} via minikube (local dev only — on a real cluster, push to a registry and use image.ref instead)...`);
		await this.run(
			["minikube", "-p", this.profile, "image", "build",
			 "-t", tag, "-f", dockerfileName, contextDir],
			`Failed to build image ${tag} via minikube`,
		);
		log(`Image built: ${tag}`);
		return { imageRef: tag, localBuild: true };
	}

	/** Lists images available in minikube's container runtime. */
	private async imageList(): Promise<string> {
		const proc = Bun.spawn(
			["minikube", "-p", this.profile, "image", "ls"],
			{ stdout: "pipe", stderr: "ignore" },
		);
		const text = await new Response(proc.stdout).text();
		await proc.exited;
		return text;
	}

	/** Runs a command asynchronously, throwing on non-zero exit. */
	private async run(args: string[], errorMessage: string): Promise<void> {
		const proc = Bun.spawn(args, { stdout: "inherit", stderr: "inherit" });
		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			throw new KubernetesRuntimeError(errorMessage);
		}
	}
}
