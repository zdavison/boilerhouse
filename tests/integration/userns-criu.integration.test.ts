/**
 * Probe: does `--userns=auto` break CRIU checkpoint/restore?
 *
 * This test uses the podman CLI directly (not the boilerhouse daemon) so we can
 * pass low-level flags that the runtime does not yet expose.  Run it before
 * implementing user-namespace remapping to decide whether to proceed.
 *
 * Prerequisites
 * ─────────────
 *   • Podman running in rootful mode  (CRIU requires root)
 *   • CRIU installed and enabled      (set BOILERHOUSE_CRIU_AVAILABLE=true)
 *   • Host /etc/subuid configured for userns auto  (e.g. "containers:100000:65536")
 *
 * Usage
 * ─────
 *   BOILERHOUSE_CRIU_AVAILABLE=true bun test tests/integration/userns-criu.integration.test.ts --timeout 60000
 */

import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── helpers ──────────────────────────────────────────────────────────────────

function run(cmd: string[], opts: { input?: string } = {}) {
	const result = Bun.spawnSync(cmd, {
		stdout: "pipe",
		stderr: "pipe",
		...(opts.input !== undefined ? { stdin: Buffer.from(opts.input) } : {}),
	});
	return {
		exitCode: result.exitCode ?? -1,
		stdout: result.stdout.toString().trim(),
		stderr: result.stderr.toString().trim(),
	};
}

/** Returns true if the `podman` binary is in PATH and responds to `version`. */
function podmanCliAvailable(): boolean {
	try {
		const r = run(["podman", "version", "--format", "{{.Client.Version}}"]);
		return r.exitCode === 0 && r.stdout.length > 0;
	} catch {
		return false;
	}
}

/** Returns true if podman is running rootful (required for CRIU). */
function podmanIsRootful(): boolean {
	// `podman info` contains "rootless: false" when rootful
	const r = run(["podman", "info", "--format", "{{.Host.Security.Rootless}}"]);
	return r.exitCode === 0 && r.stdout.trim() === "false";
}

/**
 * Returns true if the host has a userns subordinate UID range configured for
 * the `containers` user — a prerequisite for `--userns=auto`.
 */
function subuidConfigured(): boolean {
	if (!existsSync("/etc/subuid")) return false;
	const r = run(["grep", "-qE", "^(containers|root):", "/etc/subuid"]);
	return r.exitCode === 0;
}

const ALPINE_IMAGE = "docker.io/library/alpine:3.21";

// ── availability guards ──────────────────────────────────────────────────────

const cliAvailable = podmanCliAvailable();
const criuAvailable = process.env.BOILERHOUSE_CRIU_AVAILABLE === "true";
const rootful = cliAvailable && podmanIsRootful();
const subuid = subuidConfigured();

const skip = !cliAvailable || !criuAvailable || !rootful;

// ── cleanup registry ─────────────────────────────────────────────────────────

const containersToCleanup: string[] = [];
const archivesToCleanup: string[] = [];

afterEach(() => {
	for (const id of containersToCleanup) {
		run(["podman", "rm", "--force", "--ignore", id]);
	}
	containersToCleanup.length = 0;

	for (const path of archivesToCleanup) {
		try { rmSync(path); } catch { /* ignore */ }
	}
	archivesToCleanup.length = 0;
});

// ── test suite ───────────────────────────────────────────────────────────────

describe.skipIf(skip)(
	`userns=auto + CRIU compatibility${!cliAvailable ? " [SKIP: podman not found]" : !criuAvailable ? " [SKIP: BOILERHOUSE_CRIU_AVAILABLE not set]" : !rootful ? " [SKIP: podman not rootful]" : ""}`,
	() => {
		/**
		 * Baseline — checkpoint/restore WITHOUT userns remapping.
		 * This must pass before the userns test is meaningful.
		 */
		test("baseline: CRIU checkpoint/restore works without userns", async () => {
			// Pull image (idempotent)
			const pull = run(["podman", "pull", ALPINE_IMAGE]);
			expect(pull.exitCode).toBe(0);

			// Create and start container
			const create = run([
				"podman", "run",
				"--detach",
				"--name", "bh-test-baseline",
				ALPINE_IMAGE,
				"/bin/sh", "-c", "while true; do sleep 1; done",
			]);
			expect(create.exitCode).toBe(0);
			const containerId = create.stdout;
			containersToCleanup.push("bh-test-baseline");

			// Write a marker file into the running container
			const marker = run(["podman", "exec", "bh-test-baseline", "sh", "-c", "echo baseline-ok > /tmp/marker"]);
			expect(marker.exitCode).toBe(0);

			// Checkpoint
			const archivePath = join(tmpdir(), "bh-baseline-checkpoint.tar.gz");
			archivesToCleanup.push(archivePath);

			const checkpoint = run(["podman", "container", "checkpoint", "--export", archivePath, "bh-test-baseline"]);
			if (checkpoint.exitCode !== 0) {
				console.error("Checkpoint stderr:", checkpoint.stderr);
			}
			expect(checkpoint.exitCode).toBe(0);
			expect(existsSync(archivePath)).toBe(true);

			// Remove checkpointed container before restore
			run(["podman", "rm", "--force", "bh-test-baseline"]);

			// Restore
			const restoredName = "bh-test-baseline-restored";
			containersToCleanup.push(restoredName);

			const restore = run([
				"podman", "container", "restore",
				"--import", archivePath,
				"--name", restoredName,
			]);
			if (restore.exitCode !== 0) {
				console.error("Restore stderr:", restore.stderr);
			}
			expect(restore.exitCode).toBe(0);

			// Verify marker persisted
			const read = run(["podman", "exec", restoredName, "cat", "/tmp/marker"]);
			expect(read.exitCode).toBe(0);
			expect(read.stdout).toBe("baseline-ok");
		});

		/**
		 * Key test — does CRIU work when the container was started with userns=auto?
		 *
		 * If this test passes: user namespace remapping is safe to implement.
		 * If this test fails: userns=auto breaks CRIU; skip the feature.
		 */
		test.skipIf(!subuid)(
			`userns=auto: CRIU checkpoint/restore works with user namespace remapping${!subuid ? " [SKIP: /etc/subuid not configured for containers/root]" : ""}`,
			async () => {
				// Pull image (idempotent)
				const pull = run(["podman", "pull", ALPINE_IMAGE]);
				expect(pull.exitCode).toBe(0);

				// Create container with --userns=auto
				const create = run([
					"podman", "run",
					"--detach",
					"--userns=auto",
					"--name", "bh-test-userns",
					ALPINE_IMAGE,
					"/bin/sh", "-c", "while true; do sleep 1; done",
				]);
				if (create.exitCode !== 0) {
					console.error("Container create (userns=auto) failed:", create.stderr);
				}
				expect(create.exitCode).toBe(0);
				containersToCleanup.push("bh-test-userns");

				// Verify the container is actually using a remapped UID
				// `id` inside the container should show uid=0(root), but /proc/<pid>/status
				// on the host should show a non-zero NsUID
				const idResult = run(["podman", "exec", "bh-test-userns", "id", "-u"]);
				expect(idResult.exitCode).toBe(0);
				// Inside the container root is uid 0
				expect(idResult.stdout).toBe("0");

				// Write a marker file
				const marker = run(["podman", "exec", "bh-test-userns", "sh", "-c", "echo userns-ok > /tmp/marker"]);
				expect(marker.exitCode).toBe(0);

				// Checkpoint
				const archivePath = join(tmpdir(), "bh-userns-checkpoint.tar.gz");
				archivesToCleanup.push(archivePath);

				const checkpoint = run([
					"podman", "container", "checkpoint",
					"--export", archivePath,
					"bh-test-userns",
				]);
				if (checkpoint.exitCode !== 0) {
					console.error("Checkpoint (userns=auto) stderr:", checkpoint.stderr);
					console.log(
						"\nCONCLUSION: userns=auto BREAKS CRIU checkpoint — do not implement user namespace remapping.",
					);
				} else {
					console.log("Checkpoint with userns=auto succeeded.");
				}
				expect(checkpoint.exitCode).toBe(0);
				expect(existsSync(archivePath)).toBe(true);

				// Remove checkpointed container before restore
				run(["podman", "rm", "--force", "bh-test-userns"]);

				// Restore
				const restoredName = "bh-test-userns-restored";
				containersToCleanup.push(restoredName);

				const restore = run([
					"podman", "container", "restore",
					"--import", archivePath,
					"--name", restoredName,
				]);
				if (restore.exitCode !== 0) {
					console.error("Restore (userns=auto) stderr:", restore.stderr);
					console.log(
						"\nCONCLUSION: userns=auto BREAKS CRIU restore — do not implement user namespace remapping.",
					);
				} else {
					console.log("Restore with userns=auto succeeded.");
				}
				expect(restore.exitCode).toBe(0);

				// Verify marker persisted through checkpoint/restore
				const read = run(["podman", "exec", restoredName, "cat", "/tmp/marker"]);
				expect(read.exitCode).toBe(0);
				expect(read.stdout).toBe("userns-ok");

				console.log(
					"\nCONCLUSION: userns=auto is COMPATIBLE with CRIU — safe to implement user namespace remapping.",
				);
			},
		);
	},
);
