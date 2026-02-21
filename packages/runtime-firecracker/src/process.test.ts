import { describe, test, expect } from "bun:test";
import { buildJailerArgs, computeJailedSocketPath, type JailerSpawnOptions } from "./process";

describe("buildJailerArgs", () => {
	const baseOpts: JailerSpawnOptions = {
		jailerId: "inst-test-id",
		execFile: "/usr/bin/firecracker",
		jailerPath: "/usr/local/bin/jailer",
		uid: 100001,
		gid: 100000,
		chrootBaseDir: "/srv/jailer",
		netnsPath: "/var/run/netns/fc-abcd1234",
		daemonize: true,
		newPidNs: true,
		cgroupVersion: 2,
	};

	test("assembles correct base arguments", () => {
		const args = buildJailerArgs(baseOpts);

		expect(args).toContain("--id");
		expect(args[args.indexOf("--id")! + 1]).toBe("inst-test-id");

		expect(args).toContain("--exec-file");
		expect(args[args.indexOf("--exec-file")! + 1]).toBe("/usr/bin/firecracker");

		expect(args).toContain("--uid");
		expect(args[args.indexOf("--uid")! + 1]).toBe("100001");

		expect(args).toContain("--gid");
		expect(args[args.indexOf("--gid")! + 1]).toBe("100000");

		expect(args).toContain("--chroot-base-dir");
		expect(args[args.indexOf("--chroot-base-dir")! + 1]).toBe("/srv/jailer");

		expect(args).toContain("--netns");
		expect(args[args.indexOf("--netns")! + 1]).toBe("/var/run/netns/fc-abcd1234");

		expect(args).toContain("--cgroup-version");
		expect(args[args.indexOf("--cgroup-version")! + 1]).toBe("2");
	});

	test("includes --daemonize when enabled", () => {
		const args = buildJailerArgs({ ...baseOpts, daemonize: true });
		expect(args).toContain("--daemonize");
	});

	test("excludes --daemonize when disabled", () => {
		const args = buildJailerArgs({ ...baseOpts, daemonize: false });
		expect(args).not.toContain("--daemonize");
	});

	test("includes --new-pid-ns when enabled", () => {
		const args = buildJailerArgs({ ...baseOpts, newPidNs: true });
		expect(args).toContain("--new-pid-ns");
	});

	test("excludes --new-pid-ns when disabled", () => {
		const args = buildJailerArgs({ ...baseOpts, newPidNs: false });
		expect(args).not.toContain("--new-pid-ns");
	});

	test("passes firecracker args after -- separator", () => {
		const args = buildJailerArgs(baseOpts);
		const separatorIndex = args.indexOf("--");
		expect(separatorIndex).toBeGreaterThan(0);

		const fcArgs = args.slice(separatorIndex + 1);
		expect(fcArgs).toContain("--api-sock");
		expect(fcArgs).toContain("/run/firecracker.socket");
	});

	test("includes cgroup args when provided", () => {
		const args = buildJailerArgs({
			...baseOpts,
			cgroups: ["cpu.max=50000 100000"],
		});
		expect(args).toContain("--cgroup");
		expect(args[args.indexOf("--cgroup")! + 1]).toBe("cpu.max=50000 100000");
	});
});

describe("computeJailedSocketPath", () => {
	test("returns correct socket path from chrootBaseDir and jailerId", () => {
		const socketPath = computeJailedSocketPath("/srv/jailer", "inst-abc123");
		expect(socketPath).toBe(
			"/srv/jailer/firecracker/inst-abc123/root/run/firecracker.socket",
		);
	});

	test("handles different base dirs", () => {
		const socketPath = computeJailedSocketPath("/opt/jails", "my-vm-id");
		expect(socketPath).toBe(
			"/opt/jails/firecracker/my-vm-id/root/run/firecracker.socket",
		);
	});
});
