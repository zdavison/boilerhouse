import { describe, test, expect, beforeEach } from "bun:test";
import { join } from "node:path";
import { mkdirSync, writeFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { Workload } from "@boilerhouse/core";
import { OciImageBuilder } from "./image-builder";
import type { ImageBuildFns } from "./image-builder";

const WORKLOAD: Workload = {
	workload: { name: "test", version: "1.0.0" },
	image: { ref: "alpine:latest" },
	resources: { vcpus: 1, memory_mb: 256, disk_gb: 2 },
	network: { access: "none" },
	idle: { action: "hibernate" },
};

const NAMESPACED_WORKLOAD: Workload = {
	...WORKLOAD,
	image: { ref: "alpine/openclaw:main" },
};

const DOCKERFILE_WORKLOAD: Workload = {
	...WORKLOAD,
	workload: { name: "minimal", version: "0.1.0" },
	image: { dockerfile: "minimal/Dockerfile" },
};

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "image-builder-test-"));
});

function createMockFns(): ImageBuildFns & {
	pullCalls: string[];
	exportCalls: Array<{ ref: string; tarPath: string }>;
	buildImageCalls: Array<{ dockerfile: string; tarPath: string }>;
	createExt4Calls: Array<{ tarPath: string; outputPath: string; sizeGb: number }>;
	injectInitCalls: Array<{ ext4Path: string }>;
} {
	const pullCalls: string[] = [];
	const exportCalls: Array<{ ref: string; tarPath: string }> = [];
	const buildImageCalls: Array<{ dockerfile: string; tarPath: string }> = [];
	const createExt4Calls: Array<{ tarPath: string; outputPath: string; sizeGb: number }> = [];
	const injectInitCalls: Array<{ ext4Path: string }> = [];

	return {
		pullCalls,
		exportCalls,
		buildImageCalls,
		createExt4Calls,
		injectInitCalls,
		pullImage: async (ref) => {
			pullCalls.push(ref);
		},
		exportFilesystem: async (ref, tarPath) => {
			exportCalls.push({ ref, tarPath });
		},
		buildImage: async (dockerfile, tarPath) => {
			buildImageCalls.push({ dockerfile, tarPath });
		},
		createExt4: async (tarPath, outputPath, sizeGb) => {
			createExt4Calls.push({ tarPath, outputPath, sizeGb });
			mkdirSync(join(outputPath, ".."), { recursive: true });
			writeFileSync(outputPath, "fake-ext4");
		},
		injectInit: async (ext4Path) => {
			injectInitCalls.push({ ext4Path });
		},
	};
}

describe("OciImageBuilder", () => {
	describe("image.ref workloads", () => {
		test("skips build when rootfs already exists", async () => {
			const imagesDir = join(tmpDir, "images");
			const rootfsDir = join(imagesDir, "alpine", "latest");
			mkdirSync(rootfsDir, { recursive: true });
			writeFileSync(join(rootfsDir, "rootfs.ext4"), "existing");

			const fns = createMockFns();
			const builder = new OciImageBuilder(imagesDir, { fns });

			await builder.ensureRootfs(WORKLOAD);

			expect(fns.pullCalls).toHaveLength(0);
			expect(fns.exportCalls).toHaveLength(0);
			expect(fns.createExt4Calls).toHaveLength(0);
		});

		test("pulls image, exports filesystem, creates ext4 when rootfs missing", async () => {
			const imagesDir = join(tmpDir, "images");
			const fns = createMockFns();
			const builder = new OciImageBuilder(imagesDir, { fns });

			await builder.ensureRootfs(WORKLOAD);

			expect(fns.pullCalls).toEqual(["alpine:latest"]);
			expect(fns.exportCalls).toHaveLength(1);
			expect(fns.exportCalls[0]!.ref).toBe("alpine:latest");
			expect(fns.createExt4Calls).toHaveLength(1);
			expect(fns.createExt4Calls[0]!.sizeGb).toBe(2);
			expect(fns.createExt4Calls[0]!.outputPath).toBe(
				join(imagesDir, "alpine", "latest", "rootfs.ext4"),
			);
		});

		test("handles namespaced image refs", async () => {
			const imagesDir = join(tmpDir, "images");
			const fns = createMockFns();
			const builder = new OciImageBuilder(imagesDir, { fns });

			await builder.ensureRootfs(NAMESPACED_WORKLOAD);

			expect(fns.pullCalls).toEqual(["alpine/openclaw:main"]);
			expect(fns.createExt4Calls[0]!.outputPath).toBe(
				join(imagesDir, "alpine", "openclaw", "main", "rootfs.ext4"),
			);
		});

		test("cleans up partial rootfs on build failure", async () => {
			const imagesDir = join(tmpDir, "images");
			const fns = createMockFns();
			fns.createExt4 = async () => {
				throw new Error("mkfs.ext4 failed");
			};
			const builder = new OciImageBuilder(imagesDir, { fns });

			await expect(builder.ensureRootfs(WORKLOAD)).rejects.toThrow("mkfs.ext4 failed");

			const rootfsPath = join(imagesDir, "alpine", "latest", "rootfs.ext4");
			expect(existsSync(rootfsPath)).toBe(false);
		});

		test("is idempotent — second call is a no-op", async () => {
			const imagesDir = join(tmpDir, "images");
			const fns = createMockFns();
			const builder = new OciImageBuilder(imagesDir, { fns });

			await builder.ensureRootfs(WORKLOAD);
			await builder.ensureRootfs(WORKLOAD);

			expect(fns.pullCalls).toHaveLength(1);
		});
	});

	describe("image.dockerfile workloads", () => {
		test("builds from Dockerfile when rootfs missing", async () => {
			const imagesDir = join(tmpDir, "images");
			const workloadsDir = join(tmpDir, "workloads");
			mkdirSync(join(workloadsDir, "minimal"), { recursive: true });
			writeFileSync(join(workloadsDir, "minimal", "Dockerfile"), "FROM alpine:3.21");

			const fns = createMockFns();
			const builder = new OciImageBuilder(imagesDir, { fns, workloadsDir });

			await builder.ensureRootfs(DOCKERFILE_WORKLOAD);

			expect(fns.pullCalls).toHaveLength(0);
			expect(fns.exportCalls).toHaveLength(0);
			expect(fns.buildImageCalls).toHaveLength(1);
			expect(fns.buildImageCalls[0]!.dockerfile).toBe(
				join(workloadsDir, "minimal", "Dockerfile"),
			);
			expect(fns.createExt4Calls).toHaveLength(1);
			expect(fns.createExt4Calls[0]!.outputPath).toBe(
				join(imagesDir, "_builds", "minimal", "0.1.0", "rootfs.ext4"),
			);
		});

		test("skips build when rootfs already exists", async () => {
			const imagesDir = join(tmpDir, "images");
			const rootfsDir = join(imagesDir, "_builds", "minimal", "0.1.0");
			mkdirSync(rootfsDir, { recursive: true });
			writeFileSync(join(rootfsDir, "rootfs.ext4"), "existing");

			const fns = createMockFns();
			const builder = new OciImageBuilder(imagesDir, { fns });

			await builder.ensureRootfs(DOCKERFILE_WORKLOAD);

			expect(fns.buildImageCalls).toHaveLength(0);
			expect(fns.createExt4Calls).toHaveLength(0);
		});

		test("throws when workloadsDir not configured for dockerfile workload", async () => {
			const imagesDir = join(tmpDir, "images");
			const fns = createMockFns();
			const builder = new OciImageBuilder(imagesDir, { fns });

			await expect(builder.ensureRootfs(DOCKERFILE_WORKLOAD)).rejects.toThrow(
				"workloadsDir must be configured",
			);
		});

		test("cleans up partial rootfs on Dockerfile build failure", async () => {
			const imagesDir = join(tmpDir, "images");
			const workloadsDir = join(tmpDir, "workloads");
			const fns = createMockFns();
			fns.buildImage = async () => {
				throw new Error("docker build failed");
			};
			const builder = new OciImageBuilder(imagesDir, { fns, workloadsDir });

			await expect(builder.ensureRootfs(DOCKERFILE_WORKLOAD)).rejects.toThrow("docker build failed");

			const rootfsPath = join(imagesDir, "_builds", "minimal", "0.1.0", "rootfs.ext4");
			expect(existsSync(rootfsPath)).toBe(false);
		});
	});

	describe("init injection", () => {
		const INIT_CONFIG = {
			initBinaryPath: "/opt/guest-init/init",
			idleAgentPath: "/opt/guest-init/idle-agent",
			overlayInitPath: "/opt/guest-init/overlay-init.sh",
		};

		test("injects init binaries when initConfig is provided", async () => {
			const imagesDir = join(tmpDir, "images");
			const fns = createMockFns();
			const builder = new OciImageBuilder(imagesDir, { fns, initConfig: INIT_CONFIG });

			await builder.ensureRootfs(WORKLOAD);

			expect(fns.injectInitCalls).toHaveLength(1);
			expect(fns.injectInitCalls[0]!.ext4Path).toBe(
				join(imagesDir, "alpine", "latest", "rootfs.ext4"),
			);
		});

		test("skips init injection when initConfig is not provided", async () => {
			const imagesDir = join(tmpDir, "images");
			const fns = createMockFns();
			const builder = new OciImageBuilder(imagesDir, { fns });

			await builder.ensureRootfs(WORKLOAD);

			expect(fns.injectInitCalls).toHaveLength(0);
		});

		test("skips init injection when rootfs already exists", async () => {
			const imagesDir = join(tmpDir, "images");
			const rootfsDir = join(imagesDir, "alpine", "latest");
			mkdirSync(rootfsDir, { recursive: true });
			writeFileSync(join(rootfsDir, "rootfs.ext4"), "existing");

			const fns = createMockFns();
			const builder = new OciImageBuilder(imagesDir, { fns, initConfig: INIT_CONFIG });

			await builder.ensureRootfs(WORKLOAD);

			expect(fns.injectInitCalls).toHaveLength(0);
		});
	});
});
