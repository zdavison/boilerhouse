import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, expect, beforeEach, mock } from "bun:test";
import { DockerImageResolver } from "./image-resolver";
import type { DockerClient } from "./client";
import type { ImageSpec, WorkloadMeta } from "@boilerhouse/core";

function mockClient(overrides: Partial<DockerClient> = {}): DockerClient {
	return {
		imageExists: mock(async () => false),
		pullImage: mock(async () => {}),
		buildImage: mock(async () => {}),
		...overrides,
	} as unknown as DockerClient;
}

const workload: WorkloadMeta = { name: "my-service", version: "1.0.0" };

describe("DockerImageResolver", () => {
	let logs: string[];
	let log: (line: string) => void;

	beforeEach(() => {
		logs = [];
		log = (line: string) => logs.push(line);
	});

	describe("ref-based images", () => {
		test("returns cached image when imageExists returns true", async () => {
			const client = mockClient({
				imageExists: mock(async () => true),
			});
			const resolver = new DockerImageResolver(client);
			const image: ImageSpec = { ref: "alpine:3.21" };

			const result = await resolver.ensure(image, workload, log);

			expect(result).toEqual({ imageRef: "alpine:3.21", localBuild: false });
			expect(client.imageExists).toHaveBeenCalledWith("alpine:3.21");
			expect(client.pullImage).not.toHaveBeenCalled();
			expect(logs).toEqual([]);
		});

		test("pulls image when imageExists returns false", async () => {
			const client = mockClient({
				imageExists: mock(async () => false),
				pullImage: mock(async () => {}),
			});
			const resolver = new DockerImageResolver(client);
			const image: ImageSpec = { ref: "nginx:latest" };

			const result = await resolver.ensure(image, workload, log);

			expect(result).toEqual({ imageRef: "nginx:latest", localBuild: false });
			expect(client.pullImage).toHaveBeenCalledWith("nginx:latest", log);
			expect(logs).toEqual(["Pulling image nginx:latest..."]);
		});
	});

	describe("Dockerfile-based images", () => {
		test("returns cached image when tag already exists", async () => {
			const client = mockClient({
				imageExists: mock(async () => true),
			});
			const resolver = new DockerImageResolver(client);
			const image: ImageSpec = { dockerfile: "/tmp/project/Dockerfile" };

			const result = await resolver.ensure(image, workload, log);

			expect(result).toEqual({
				imageRef: "boilerhouse/my-service:1.0.0",
				localBuild: true,
			});
			expect(client.imageExists).toHaveBeenCalledWith("boilerhouse/my-service:1.0.0");
			expect(client.buildImage).not.toHaveBeenCalled();
			expect(logs).toEqual([]);
		});

		test("builds image when tag does not exist", async () => {
			const dir = mkdtempSync(join(tmpdir(), "bh-test-"));
			writeFileSync(join(dir, "Dockerfile"), "FROM alpine:3.21\n");

			const client = mockClient({
				imageExists: mock(async () => false),
				buildImage: mock(async () => {}),
			});
			const resolver = new DockerImageResolver(client);
			const image: ImageSpec = { dockerfile: join(dir, "Dockerfile") };

			const result = await resolver.ensure(image, workload, log);

			expect(result).toEqual({
				imageRef: "boilerhouse/my-service:1.0.0",
				localBuild: true,
			});
			expect(client.buildImage).toHaveBeenCalled();
			expect(logs[0]).toBe("Building image from Dockerfile...");
		});
	});
});
