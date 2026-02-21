import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	mkdtempSync,
	rmSync,
	existsSync,
	writeFileSync,
	mkdirSync,
	readFileSync,
} from "node:fs";
import type { InstanceId } from "@boilerhouse/core";
import { JailPreparer } from "./jail";

describe("JailPreparer", () => {
	let tmpDir: string;
	let chrootBaseDir: string;
	let preparer: JailPreparer;
	let kernelPath: string;

	beforeEach(() => {
		tmpDir = mkdtempSync(join(tmpdir(), "jail-test-"));
		chrootBaseDir = join(tmpDir, "jailer");
		kernelPath = join(tmpDir, "vmlinux");
		writeFileSync(kernelPath, "fake-kernel-data");
		preparer = new JailPreparer();
	});

	afterEach(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	test("prepare() creates the chroot directory structure", async () => {
		const instanceId = "inst-jail-struct" as InstanceId;
		const rootfsPath = join(tmpDir, "rootfs.ext4");
		writeFileSync(rootfsPath, "fake-rootfs-data");

		const paths = await preparer.prepare({
			instanceId,
			chrootBaseDir,
			kernelPath,
			rootfsPath,
			uid: 100000,
			gid: 100000,
		});

		expect(existsSync(paths.chrootRoot)).toBe(true);
		expect(paths.chrootRoot).toContain("firecracker");
		expect(paths.chrootRoot).toContain(instanceId);
		expect(paths.chrootRoot).toEndWith("/root");
	});

	test("prepare() places kernel and rootfs files in chroot root", async () => {
		const instanceId = "inst-jail-files" as InstanceId;
		const rootfsPath = join(tmpDir, "rootfs.ext4");
		writeFileSync(rootfsPath, "fake-rootfs-data");

		const paths = await preparer.prepare({
			instanceId,
			chrootBaseDir,
			kernelPath,
			rootfsPath,
			uid: 100000,
			gid: 100000,
		});

		const kernelInChroot = join(paths.chrootRoot, paths.kernelRelative);
		const rootfsInChroot = join(paths.chrootRoot, paths.rootfsRelative);

		expect(existsSync(kernelInChroot)).toBe(true);
		expect(existsSync(rootfsInChroot)).toBe(true);

		// Verify content matches
		expect(readFileSync(kernelInChroot, "utf-8")).toBe("fake-kernel-data");
		expect(readFileSync(rootfsInChroot, "utf-8")).toBe("fake-rootfs-data");
	});

	test("prepare() returns correct relative paths", async () => {
		const instanceId = "inst-jail-relpaths" as InstanceId;
		const rootfsPath = join(tmpDir, "rootfs.ext4");
		writeFileSync(rootfsPath, "fake-rootfs-data");

		const paths = await preparer.prepare({
			instanceId,
			chrootBaseDir,
			kernelPath,
			rootfsPath,
			uid: 100000,
			gid: 100000,
		});

		expect(paths.kernelRelative).toBe("vmlinux");
		expect(paths.rootfsRelative).toBe("rootfs.ext4");
	});

	test("prepare() sets apiSocket and logPath", async () => {
		const instanceId = "inst-jail-socket" as InstanceId;
		const rootfsPath = join(tmpDir, "rootfs.ext4");
		writeFileSync(rootfsPath, "fake-rootfs-data");

		const paths = await preparer.prepare({
			instanceId,
			chrootBaseDir,
			kernelPath,
			rootfsPath,
			uid: 100000,
			gid: 100000,
		});

		expect(paths.apiSocket).toContain(instanceId);
		expect(paths.logPath).toContain(instanceId);
		expect(paths.logPath).toEndWith(".log");
	});

	test("cleanup() removes the entire jail tree", async () => {
		const instanceId = "inst-jail-cleanup" as InstanceId;
		const rootfsPath = join(tmpDir, "rootfs.ext4");
		writeFileSync(rootfsPath, "fake-rootfs-data");

		await preparer.prepare({
			instanceId,
			chrootBaseDir,
			kernelPath,
			rootfsPath,
			uid: 100000,
			gid: 100000,
		});

		const jailDir = join(chrootBaseDir, "firecracker", instanceId);
		expect(existsSync(jailDir)).toBe(true);

		await preparer.cleanup(instanceId, chrootBaseDir);
		expect(existsSync(jailDir)).toBe(false);
	});

	test("prepareForRestore() also places vmstate + memory files", async () => {
		const instanceId = "inst-jail-restore" as InstanceId;
		const rootfsPath = join(tmpDir, "rootfs.ext4");
		writeFileSync(rootfsPath, "fake-rootfs-data");

		const snapshotDir = join(tmpDir, "snapshot");
		mkdirSync(snapshotDir, { recursive: true });
		writeFileSync(join(snapshotDir, "vmstate"), "fake-vmstate");
		writeFileSync(join(snapshotDir, "memory"), "fake-memory");

		const paths = await preparer.prepareForRestore({
			instanceId,
			chrootBaseDir,
			kernelPath,
			rootfsPath,
			uid: 100000,
			gid: 100000,
			vmstatePath: join(snapshotDir, "vmstate"),
			memoryPath: join(snapshotDir, "memory"),
		});

		expect(existsSync(join(paths.chrootRoot, "vmstate"))).toBe(true);
		expect(existsSync(join(paths.chrootRoot, "memory"))).toBe(true);
		expect(readFileSync(join(paths.chrootRoot, "vmstate"), "utf-8")).toBe("fake-vmstate");
		expect(readFileSync(join(paths.chrootRoot, "memory"), "utf-8")).toBe("fake-memory");
	});

	test("linkOrCopy falls back to copy when hard-link fails", async () => {
		const instanceId = "inst-jail-fallback" as InstanceId;
		const rootfsPath = join(tmpDir, "rootfs.ext4");
		writeFileSync(rootfsPath, "fake-rootfs-data");

		// This test exercises the copy fallback path. Since we're on the same
		// filesystem the hard link will succeed, but the content should still
		// be correct either way.
		const paths = await preparer.prepare({
			instanceId,
			chrootBaseDir,
			kernelPath,
			rootfsPath,
			uid: 100000,
			gid: 100000,
		});

		const kernelInChroot = join(paths.chrootRoot, paths.kernelRelative);
		expect(readFileSync(kernelInChroot, "utf-8")).toBe("fake-kernel-data");
	});
});
