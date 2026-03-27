import { test, expect, describe } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";

const alertsPath = join(import.meta.dir, "alerts.yml");
const alertsYaml = readFileSync(alertsPath, "utf-8");

describe("Prometheus alerts.yml", () => {
	test("contains PoolExhausted alert rule", () => {
		expect(alertsYaml).toContain("PoolExhausted");
	});

	test("alert fires when pool_depth == 0 for 30s", () => {
		expect(alertsYaml).toContain("pool_depth == 0");
		expect(alertsYaml).toContain("30s");
	});

	test("alert has severity: warning label", () => {
		expect(alertsYaml).toContain("severity: warning");
	});

	test("alert has a summary annotation", () => {
		expect(alertsYaml).toContain("summary:");
	});
});
