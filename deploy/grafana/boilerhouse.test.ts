import { test, expect, describe } from "bun:test";
import dashboard from "./boilerhouse.json";

type Panel = { title?: string; type?: string; panels?: Panel[] };

/** Flattens nested panels (rows can contain collapsed sub-panels). */
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
	test("contains Pool depth panel", () => {
		expect(titles).toContain("Pool depth");
	});

	test("contains Acquire source panel", () => {
		expect(titles).toContain("Acquire source");
	});

	test("does not contain snapshot/golden panels (CRIU-era)", () => {
		expect(titles).not.toContain("Snapshots");
		expect(titles).not.toContain("Golden Queue Depth");
		expect(titles).not.toContain("Disk Usage");
	});
});
