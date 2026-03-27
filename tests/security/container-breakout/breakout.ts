import { randomUUID } from "node:crypto";
import { availableRuntimes, E2E_TIMEOUTS } from "../../e2e/runtime-matrix";
import {
	startE2EServer,
	api,
	readFixture,
	waitForWorkloadReady,
	type E2EServer,
} from "../../e2e/e2e-helpers";
import { ensureCDK } from "./tools";

async function execIn(
	server: E2EServer,
	instanceId: string,
	command: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const res = await api(server, "POST", `/api/v1/instances/${instanceId}/exec`, { command });
	if (res.status !== 200) {
		throw new Error(`exec failed: HTTP ${res.status}`);
	}
	return res.json() as Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

async function uploadBinary(
	runtime: string,
	instanceId: string,
	localPath: string,
	remotePath: string,
): Promise<void> {
	if (runtime === "kubernetes") {
		await kubectlCp(instanceId, localPath, remotePath);
	} else {
		await podmanCp(instanceId, localPath, remotePath);
	}
}

async function podmanCp(instanceId: string, localPath: string, remotePath: string): Promise<void> {
	await runOrThrow(["podman", "cp", localPath, `${instanceId}:${remotePath}`]);
	await runOrThrow(["podman", "exec", instanceId, "chmod", "+x", remotePath]);
}

async function kubectlCp(instanceId: string, localPath: string, remotePath: string): Promise<void> {
	const ctx = "boilerhouse-test";
	const ns = "boilerhouse";
	await runOrThrow([
		"kubectl", "--context", ctx, "-n", ns, "cp",
		localPath, `${instanceId}:${remotePath}`, "-c", "main",
	]);
	await runOrThrow([
		"kubectl", "--context", ctx, "-n", ns, "exec", instanceId,
		"-c", "main", "--", "chmod", "+x", remotePath,
	]);
}

async function runOrThrow(cmd: string[]): Promise<void> {
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new Error(`${cmd[0]} failed (exit ${exitCode}): ${stderr}`);
	}
}

function parseCDKFindings(output: string): string[] {
	return output
		.split("\n")
		.filter((line) => line.includes("[!]"))
		.map((line) => line.trim());
}

const CRITICAL_VECTORS = [
	"privileged mode",
	"docker.sock",
	"podman.sock",
	"/var/run/docker",
	"mount host",
	"SYS_ADMIN",
	"SYS_PTRACE",
	"DAC_READ_SEARCH",
];

// ── Main ────────────────────────────────────────────────────────────────────

const realRuntimes = availableRuntimes().filter(
	(rt) => rt.name !== "fake" && rt.capabilities.exec && rt.capabilities.networking,
);

if (realRuntimes.length === 0) {
	console.log("No real runtimes available — skipping breakout scan");
	process.exit(0);
}

const cdkPath = await ensureCDK();
let exitCode = 0;

for (const rt of realRuntimes) {
	const timeouts = E2E_TIMEOUTS[rt.name as keyof typeof E2E_TIMEOUTS] ?? E2E_TIMEOUTS.fake;

	console.log(`\n── [${rt.name}] CDK container breakout scan ──\n`);

	const server = await startE2EServer(rt.name);
	try {
		const fixture = await readFixture(rt.workloadFixtures.openclaw);
		const registerRes = await api(server, "POST", "/api/v1/workloads", fixture);
		if (registerRes.status !== 201) {
			console.error(`  workload registration failed: HTTP ${registerRes.status}`);
			exitCode = 1;
			continue;
		}
		const { name: workloadName } = (await registerRes.json()) as { name: string };
		await waitForWorkloadReady(server, workloadName, timeouts.operation);

		const tenantId = randomUUID();
		const claimRes = await api(server, "POST", `/api/v1/tenants/${tenantId}/claim`, {
			workload: workloadName,
		});
		if (claimRes.status !== 200) {
			console.error(`  claim failed: HTTP ${claimRes.status}`);
			exitCode = 1;
			continue;
		}
		const { instanceId } = (await claimRes.json()) as { instanceId: string };

		await uploadBinary(rt.name, instanceId, cdkPath, "/tmp/cdk");

		const result = await execIn(server, instanceId, [
			"sh", "-c", "/tmp/cdk evaluate 2>&1",
		]);

		const output = result.stdout + "\n" + result.stderr;
		const findings = parseCDKFindings(output);

		console.log(output);

		if (findings.length > 0) {
			console.log("\n  Findings:");
			for (const f of findings) console.log(`    ${f}`);
		}

		const criticalFindings = findings.filter((f) =>
			CRITICAL_VECTORS.some((c) => f.toLowerCase().includes(c.toLowerCase())),
		);

		if (criticalFindings.length > 0) {
			console.error("\n  CRITICAL escape vectors detected:");
			for (const f of criticalFindings) console.error(`    ${f}`);
			exitCode = 1;
		} else {
			console.log("\n  No critical escape vectors found.");
		}

		await api(server, "POST", `/api/v1/tenants/${tenantId}/release`);
	} finally {
		await server.cleanup();
	}
}

process.exit(exitCode);
