import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";

const CACHE_DIR = join(dirname(import.meta.path), ".cache");

const CDK_VERSION = "v1.5.3";
const CDK_URL = `https://github.com/cdk-team/CDK/releases/download/${CDK_VERSION}/cdk_linux_amd64`;
const CDK_SHA256 = "d7f0690e41786270f345ff4851fd4b239631d4c1e7a6b9f74ad139565cbdb2ed";

/**
 * Downloads the CDK binary to the local cache if not already present.
 * Verifies SHA256 checksum on download.
 * Returns the absolute path to the cached binary.
 */
export async function ensureCDK(): Promise<string> {
	const dest = join(CACHE_DIR, "cdk_linux_amd64");

	if (existsSync(dest)) {
		return dest;
	}

	mkdirSync(CACHE_DIR, { recursive: true });

	const headers: Record<string, string> = {};
	if (process.env.GITHUB_TOKEN) {
		headers.Authorization = `token ${process.env.GITHUB_TOKEN}`;
	}

	console.log(`Downloading CDK ${CDK_VERSION}...`);
	const res = await fetch(CDK_URL, { headers, redirect: "follow" });
	if (!res.ok) {
		throw new Error(`Failed to download CDK: ${res.status} ${res.statusText}`);
	}

	const buf = Buffer.from(await res.arrayBuffer());

	const hash = createHash("sha256").update(buf).digest("hex");
	if (hash !== CDK_SHA256) {
		throw new Error(
			`CDK checksum mismatch: expected ${CDK_SHA256}, got ${hash}`,
		);
	}

	await Bun.write(dest, buf);
	// Make executable for local reference (the binary runs inside the container)
	const { exitCode } = Bun.spawnSync(["chmod", "+x", dest]);
	if (exitCode !== 0) {
		throw new Error("Failed to chmod CDK binary");
	}

	console.log(`CDK ${CDK_VERSION} cached at ${dest}`);
	return dest;
}
