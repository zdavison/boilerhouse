import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";
import type { ImageResolver, ImageResolveResult, ImageSpec, WorkloadMeta } from "@boilerhouse/core";
import { DockerClient } from "./client";
import { DockerRuntimeError } from "./errors";

/**
 * Resolves images using the local Docker daemon.
 * Pulls from registries or builds from Dockerfiles.
 */
export class DockerImageResolver implements ImageResolver {
	constructor(private readonly client: DockerClient) {}

	async ensure(
		image: ImageSpec,
		workload: WorkloadMeta,
		log: (line: string) => void,
	): Promise<ImageResolveResult> {
		if (image.dockerfile) {
			return this.ensureDockerfile(image.dockerfile, workload, log);
		}

		return this.ensureRef(image.ref!, log);
	}

	private async ensureRef(
		ref: string,
		log: (line: string) => void,
	): Promise<ImageResolveResult> {
		if (await this.client.imageExists(ref)) {
			return { imageRef: ref, localBuild: false };
		}

		log(`Pulling image ${ref}...`);
		await this.client.pullImage(ref, log);
		return { imageRef: ref, localBuild: false };
	}

	private async ensureDockerfile(
		dockerfile: string,
		workload: WorkloadMeta,
		log: (line: string) => void,
	): Promise<ImageResolveResult> {
		const dockerfilePath = resolve(dockerfile);
		const contextDir = dirname(dockerfilePath);
		const dockerfileRelPath = basename(dockerfilePath);
		const tag = `boilerhouse/${workload.name}:${workload.version}`;

		if (await this.client.imageExists(tag)) {
			return { imageRef: tag, localBuild: true };
		}

		log(`Building image from ${dockerfileRelPath}...`);
		const tar = await this.createContextTar(contextDir);
		await this.client.buildImage(tar, tag, dockerfileRelPath, log);
		return { imageRef: tag, localBuild: true };
	}

	private async createContextTar(contextDir: string): Promise<Buffer> {
		const tmpDir = mkdtempSync(join(tmpdir(), "bh-docker-build-"));
		const tarPath = join(tmpDir, "context.tar");
		try {
			try {
				await Bun.$`tar -cf ${tarPath} -C ${contextDir} .`.quiet();
			} catch (err) {
				let detail = "";
				if (err instanceof Error && "stderr" in err) {
					const raw = (err as Error & { stderr: unknown }).stderr;
					detail = Buffer.isBuffer(raw) ? raw.toString("utf-8").trim() : String(raw);
				}
				throw new DockerRuntimeError(
					`Failed to create build context tar${detail ? `: ${detail}` : ""}`,
				);
			}
			const data = await Bun.file(tarPath).arrayBuffer();
			return Buffer.from(data);
		} finally {
			await Bun.$`rm -rf ${tmpDir}`.quiet().nothrow();
		}
	}
}
