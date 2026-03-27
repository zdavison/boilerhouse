import { test, expect, describe } from "bun:test";
import dashboard from "./boilerhouse.json";

type Panel = { title?: string; type?: string; panels?: Panel[] };

function allPanels(panels: Panel[]): Panel[] {
	const result: Panel[] = [];
	for (const p of panels) {
		result.push(p);
		if (p.panels) result.push(...p.panels);
	}
	return result;
}

const panels = allPanels(dashboard.panels as Panel[]);
const titles = panels.map((p) => p.title ?? "");

describe("boilerhouse Grafana dashboard", () => {
	test("contains Claim Latency section", () => {
		expect(titles).toContain("Claim Latency");
		expect(titles).toContain("Claim p95");
		expect(titles).toContain("Claim Latency Over Time");
		expect(titles).toContain("Claim p95 by Source");
	});

	test("contains Tenant Usage section", () => {
		expect(titles).toContain("Tenant Usage");
		expect(titles).toContain("Usage by Tenant");
	});

	test("contains Cold Starts section", () => {
		expect(titles).toContain("Cold Starts");
		expect(titles).toContain("Pool Hit Rate");
		expect(titles).toContain("Claims by Source");
	});

	test("contains Snapshot Storage section", () => {
		expect(titles).toContain("Snapshot Storage");
		expect(titles).toContain("Snapshot Size per Tenant");
		expect(titles).toContain("Snapshot Disk Over Time");
	});

	test("contains Node Resources section", () => {
		expect(titles).toContain("Node Resources");
		expect(titles).toContain("Memory: Containers + System");
		expect(titles).toContain("CPU: Containers + System");
	});
});
