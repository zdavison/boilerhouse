export interface PrometheusSample {
	name: string;
	labels: Record<string, string>;
	value: number;
}

export type MetricType = "counter" | "gauge" | "histogram" | "summary" | "untyped";

export interface MetricFamily {
	name: string;
	help: string;
	type: MetricType;
	samples: PrometheusSample[];
}

export interface PrometheusMetrics {
	families: MetricFamily[];
	byName: Map<string, MetricFamily>;
}

/**
 * Parses Prometheus exposition format text into structured metrics.
 *
 * Handles `# HELP`, `# TYPE`, sample lines with labels, escaped label values,
 * NaN, and +Inf values.
 */
export function parsePrometheus(text: string): PrometheusMetrics {
	const families: MetricFamily[] = [];
	const byName = new Map<string, MetricFamily>();

	let currentFamily: MetricFamily | null = null;

	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (line === "") continue;

		if (line.startsWith("# HELP ")) {
			const rest = line.slice(7);
			const spaceIdx = rest.indexOf(" ");
			const rawName = spaceIdx >= 0 ? rest.slice(0, spaceIdx) : rest;
			const help = spaceIdx >= 0 ? rest.slice(spaceIdx + 1) : "";
			const name = stripSuffix(rawName);

			currentFamily = byName.get(name) ?? null;
			if (!currentFamily) {
				currentFamily = { name, help, type: "untyped", samples: [] };
				families.push(currentFamily);
				byName.set(name, currentFamily);
			} else {
				currentFamily.help = help;
			}
			continue;
		}

		if (line.startsWith("# TYPE ")) {
			const rest = line.slice(7);
			const spaceIdx = rest.indexOf(" ");
			const rawName = spaceIdx >= 0 ? rest.slice(0, spaceIdx) : rest;
			const typeStr = spaceIdx >= 0 ? rest.slice(spaceIdx + 1) : "untyped";
			const name = stripSuffix(rawName);

			currentFamily = byName.get(name) ?? null;
			if (!currentFamily) {
				currentFamily = { name, help: "", type: typeStr as MetricType, samples: [] };
				families.push(currentFamily);
				byName.set(name, currentFamily);
			} else {
				currentFamily.type = typeStr as MetricType;
			}
			continue;
		}

		if (line.startsWith("#")) continue;

		// Parse sample line: metric_name{label="value",...} value
		const sample = parseSampleLine(line);
		if (!sample) continue;

		// Find the family for this sample
		const familyName = stripSuffix(sample.name);
		let family = byName.get(familyName);
		if (!family) {
			family = { name: familyName, help: "", type: "untyped", samples: [] };
			families.push(family);
			byName.set(familyName, family);
		}
		family.samples.push(sample);
	}

	return { families, byName };
}

/** Fetches and parses the /metrics endpoint. */
export async function fetchMetrics(): Promise<PrometheusMetrics> {
	const res = await fetch("/metrics");
	if (!res.ok) {
		throw new Error(`Failed to fetch metrics: ${res.status} ${res.statusText}`);
	}
	const text = await res.text();
	return parsePrometheus(text);
}

/** Extracts gauge samples for a metric family. */
export function getGaugeValues(
	metrics: PrometheusMetrics,
	name: string,
): PrometheusSample[] {
	const family = metrics.byName.get(name);
	if (!family) return [];
	// For gauges, all samples are direct values (no _total/_bucket suffix)
	return family.samples.filter((s) => s.name === name);
}

/** Extracts counter total samples (strips _total suffix). */
export function getCounterValues(
	metrics: PrometheusMetrics,
	name: string,
): PrometheusSample[] {
	const family = metrics.byName.get(name);
	if (!family) return [];
	return family.samples.filter(
		(s) => s.name === `${name}_total` || s.name === name,
	);
}

/**
 * Computes a percentile from histogram bucket data using linear interpolation.
 * Uses the same algorithm as Prometheus's `histogram_quantile`.
 *
 * @returns The computed percentile value, or null if data is missing.
 */
export function computePercentile(
	metrics: PrometheusMetrics,
	name: string,
	percentile: number,
	filterLabels?: Record<string, string>,
): number | null {
	const family = metrics.byName.get(name);
	if (!family) return null;

	// Get bucket samples
	let buckets = family.samples.filter((s) => s.name === `${name}_bucket`);

	if (filterLabels) {
		buckets = buckets.filter((s) =>
			Object.entries(filterLabels).every(([k, v]) => s.labels[k] === v),
		);
	}

	if (buckets.length === 0) return null;

	// Sort by le boundary
	const sorted = buckets
		.map((s) => ({
			le: s.labels.le === "+Inf" ? Infinity : Number(s.labels.le),
			count: s.value,
		}))
		.sort((a, b) => a.le - b.le);

	// Find total count from +Inf bucket
	const total = sorted[sorted.length - 1]!.count;
	if (total === 0) return null;

	const target = percentile * total;

	// Linear interpolation between bucket boundaries
	let prevCount = 0;
	let prevBound = 0;

	for (const bucket of sorted) {
		if (bucket.count >= target) {
			// Target falls in this bucket
			const rangeCount = bucket.count - prevCount;
			if (rangeCount === 0) return prevBound;

			const fraction = (target - prevCount) / rangeCount;
			return prevBound + fraction * (bucket.le - prevBound);
		}
		prevCount = bucket.count;
		prevBound = bucket.le;
	}

	// Should not reach here, but return the highest boundary
	return sorted[sorted.length - 1]!.le;
}

/**
 * Computes the mean of a histogram from its _sum and _count samples.
 * Returns null if there are no observations.
 */
export function getHistogramAvg(
	metrics: PrometheusMetrics,
	name: string,
	filterLabels?: Record<string, string>,
): number | null {
	const family = metrics.byName.get(name);
	if (!family) return null;

	const matches = (s: PrometheusSample) =>
		!filterLabels || Object.entries(filterLabels).every(([k, v]) => s.labels[k] === v);

	const sumSamples = family.samples.filter((s) => s.name === `${name}_sum` && matches(s));
	const countSamples = family.samples.filter((s) => s.name === `${name}_count` && matches(s));

	const total = sumSamples.reduce((acc, s) => acc + s.value, 0);
	const count = countSamples.reduce((acc, s) => acc + s.value, 0);

	if (count === 0) return null;
	return total / count;
}

/** Groups samples by a label value. */
export function groupByLabel(
	samples: PrometheusSample[],
	labelKey: string,
): Map<string, PrometheusSample[]> {
	const groups = new Map<string, PrometheusSample[]>();
	for (const sample of samples) {
		const key = sample.labels[labelKey] ?? "";
		let group = groups.get(key);
		if (!group) {
			group = [];
			groups.set(key, group);
		}
		group.push(sample);
	}
	return groups;
}

// ── Prometheus range query (for seeding timeseries on load) ──────────────────

export interface RangeSeriesPoint {
	time: string;
	[key: string]: string | number;
}

interface PromQueryResult {
	status: string;
	data: {
		resultType: string;
		result: Array<{
			metric: Record<string, string>;
			values: Array<[number, string]>;
		}>;
	};
}

/**
 * Queries Prometheus `query_range` for a metric and returns time series points.
 *
 * @param query - PromQL query string
 * @param labelKey - Which label to use as the series key (e.g. "tenant")
 * @param rangeMinutes - How far back to query (default 10 minutes)
 * @param stepSeconds - Step interval (default 15s to match scrape interval)
 */
export async function fetchRange(
	query: string,
	labelKey: string,
	{ rangeMinutes = 10, stepSeconds = 15 } = {},
): Promise<RangeSeriesPoint[]> {
	const end = Math.floor(Date.now() / 1000);
	const start = end - rangeMinutes * 60;
	const params = new URLSearchParams({
		query,
		start: String(start),
		end: String(end),
		step: String(stepSeconds),
	});

	let json: PromQueryResult;
	try {
		const res = await fetch(`/prometheus/api/v1/query_range?${params}`);
		if (!res.ok) return [];
		json = await res.json() as PromQueryResult;
	} catch {
		return [];
	}

	if (json.status !== "success" || json.data.resultType !== "matrix") return [];

	// Build a map of timestamp → { seriesKey: value }
	const pointMap = new Map<number, Record<string, number>>();

	for (const series of json.data.result) {
		const key = series.metric[labelKey] ?? series.metric.__name__ ?? "value";
		for (const [ts, val] of series.values) {
			let point = pointMap.get(ts);
			if (!point) {
				point = {};
				pointMap.set(ts, point);
			}
			point[key] = Number(val);
		}
	}

	// Convert to sorted array of TimeSeriesPoints
	return [...pointMap.entries()]
		.sort(([a], [b]) => a - b)
		.map(([ts, values]) => ({
			time: new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
			...values,
		}));
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Strips Prometheus metric suffixes (_total, _bucket, _sum, _count, _info). */
function stripSuffix(name: string): string {
	return name.replace(/_(total|bucket|sum|count|info|created)$/, "");
}

/** Parses a single sample line like `metric_name{label="value"} 42`. */
function parseSampleLine(line: string): PrometheusSample | null {
	let name: string;
	let labels: Record<string, string> = {};
	let valueStr: string;

	const braceIdx = line.indexOf("{");

	if (braceIdx >= 0) {
		name = line.slice(0, braceIdx);
		const closeBrace = findClosingBrace(line, braceIdx);
		if (closeBrace < 0) return null;

		labels = parseLabels(line.slice(braceIdx + 1, closeBrace));
		valueStr = line.slice(closeBrace + 1).trim();
	} else {
		const parts = line.split(/\s+/);
		if (parts.length < 2) return null;
		name = parts[0]!;
		valueStr = parts[1]!;
	}

	// Strip optional timestamp after value
	const valueParts = valueStr.split(/\s+/);
	const value = Number(valueParts[0]);

	return { name, labels, value };
}

/** Finds the closing brace, accounting for escaped quotes in label values. */
function findClosingBrace(line: string, openIdx: number): number {
	let inQuote = false;
	for (let i = openIdx + 1; i < line.length; i++) {
		const ch = line[i];
		if (inQuote) {
			if (ch === "\\" && i + 1 < line.length) {
				i++; // skip escaped char
				continue;
			}
			if (ch === '"') {
				inQuote = false;
			}
		} else {
			if (ch === '"') {
				inQuote = true;
			} else if (ch === "}") {
				return i;
			}
		}
	}
	return -1;
}

/** Parses the content between `{` and `}` into a label map. */
function parseLabels(content: string): Record<string, string> {
	const labels: Record<string, string> = {};
	let i = 0;

	while (i < content.length) {
		// Skip whitespace and commas
		while (i < content.length && (content[i] === "," || content[i] === " ")) i++;
		if (i >= content.length) break;

		// Read key
		const eqIdx = content.indexOf("=", i);
		if (eqIdx < 0) break;
		const key = content.slice(i, eqIdx).trim();

		// Read quoted value
		const quoteStart = content.indexOf('"', eqIdx + 1);
		if (quoteStart < 0) break;

		let value = "";
		let j = quoteStart + 1;
		while (j < content.length) {
			if (content[j] === "\\") {
				j++;
				if (j < content.length) {
					const escaped = content[j];
					if (escaped === "n") value += "\n";
					else if (escaped === "\\") value += "\\";
					else if (escaped === '"') value += '"';
					else value += escaped;
				}
			} else if (content[j] === '"') {
				break;
			} else {
				value += content[j];
			}
			j++;
		}

		labels[key] = value;
		i = j + 1;
	}

	return labels;
}
