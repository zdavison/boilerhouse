import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { resolveWorkloadConfig } from "../packages/core/src/workload";
import type { WorkloadConfig } from "../packages/core/src/workload";

const WORKLOADS_DIR = new URL(".", import.meta.url).pathname;

describe("workload definitions", () => {
	const glob = new Glob("**/*.workload.ts");
	const files = Array.from(glob.scanSync({ cwd: WORKLOADS_DIR }));

	test("at least one .workload.ts file exists", () => {
		expect(files.length).toBeGreaterThan(0);
	});

	for (const file of files) {
		test(`${file} resolves without errors`, async () => {
			const mod = await import(`${WORKLOADS_DIR}${file}`);
			const config = mod.default as WorkloadConfig;
			expect(() => resolveWorkloadConfig(config)).not.toThrow();
		});
	}
});
