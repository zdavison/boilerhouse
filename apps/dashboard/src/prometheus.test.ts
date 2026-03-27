import { test, expect, describe } from "bun:test";
import {
	parsePrometheus,
	getGaugeValues,
	getCounterValues,
	computePercentile,
	groupByLabel,
} from "./prometheus";

const SAMPLE_METRICS = `# HELP boilerhouse_tenants_active Currently active tenants
# TYPE boilerhouse_tenants_active gauge
boilerhouse_tenants_active{workload="my-app"} 5
boilerhouse_tenants_active{workload="other-app"} 3

# HELP boilerhouse_tenant_claims_total Total tenant claim attempts
# TYPE boilerhouse_tenant_claims_total counter
boilerhouse_tenant_claims_total{workload="my-app",source="golden",outcome="ok"} 42
boilerhouse_tenant_claims_total{workload="my-app",source="snapshot",outcome="ok"} 10
boilerhouse_tenant_claims_total{workload="my-app",source="golden",outcome="error"} 2

# HELP boilerhouse_tenant_claim_duration_seconds Tenant claim latency
# TYPE boilerhouse_tenant_claim_duration_seconds histogram
boilerhouse_tenant_claim_duration_seconds_bucket{workload="my-app",le="0.05"} 0
boilerhouse_tenant_claim_duration_seconds_bucket{workload="my-app",le="0.1"} 5
boilerhouse_tenant_claim_duration_seconds_bucket{workload="my-app",le="0.25"} 20
boilerhouse_tenant_claim_duration_seconds_bucket{workload="my-app",le="0.5"} 40
boilerhouse_tenant_claim_duration_seconds_bucket{workload="my-app",le="1"} 48
boilerhouse_tenant_claim_duration_seconds_bucket{workload="my-app",le="2.5"} 50
boilerhouse_tenant_claim_duration_seconds_bucket{workload="my-app",le="5"} 50
boilerhouse_tenant_claim_duration_seconds_bucket{workload="my-app",le="10"} 50
boilerhouse_tenant_claim_duration_seconds_bucket{workload="my-app",le="30"} 50
boilerhouse_tenant_claim_duration_seconds_bucket{workload="my-app",le="+Inf"} 50
boilerhouse_tenant_claim_duration_seconds_sum{workload="my-app"} 12.5
boilerhouse_tenant_claim_duration_seconds_count{workload="my-app"} 50
`;

describe("parsePrometheus", () => {
	test("parses gauge metric", () => {
		const result = parsePrometheus(SAMPLE_METRICS);
		const family = result.byName.get("boilerhouse_tenants_active");
		expect(family).toBeDefined();
		expect(family!.type).toBe("gauge");
		expect(family!.help).toBe("Currently active tenants");
		expect(family!.samples).toHaveLength(2);
		expect(family!.samples[0]!.value).toBe(5);
		expect(family!.samples[0]!.labels.workload).toBe("my-app");
	});

	test("parses counter metric (with _total suffix)", () => {
		const result = parsePrometheus(SAMPLE_METRICS);
		const family = result.byName.get("boilerhouse_tenant_claims");
		expect(family).toBeDefined();
		expect(family!.type).toBe("counter");
		expect(family!.samples).toHaveLength(3);
	});

	test("parses histogram metric (buckets, sum, count)", () => {
		const result = parsePrometheus(SAMPLE_METRICS);
		const family = result.byName.get("boilerhouse_tenant_claim_duration_seconds");
		expect(family).toBeDefined();
		expect(family!.type).toBe("histogram");
		// 10 buckets + sum + count = 12 samples
		expect(family!.samples).toHaveLength(12);
	});

	test("handles empty input", () => {
		const result = parsePrometheus("");
		expect(result.families).toHaveLength(0);
		expect(result.byName.size).toBe(0);
	});

	test("handles NaN values", () => {
		const result = parsePrometheus(
			"# TYPE my_gauge gauge\nmy_gauge NaN\n",
		);
		const family = result.byName.get("my_gauge");
		expect(family!.samples[0]!.value).toBeNaN();
	});

	test("handles +Inf in bucket boundaries", () => {
		const result = parsePrometheus(SAMPLE_METRICS);
		const family = result.byName.get("boilerhouse_tenant_claim_duration_seconds");
		const infBucket = family!.samples.find(
			(s) => s.name.endsWith("_bucket") && s.labels.le === "+Inf",
		);
		expect(infBucket).toBeDefined();
		expect(infBucket!.value).toBe(50);
	});

	test("handles escaped label values", () => {
		const text = `# TYPE my_gauge gauge
my_gauge{label="value with \\"quotes\\" and \\\\backslash"} 42
`;
		const result = parsePrometheus(text);
		const family = result.byName.get("my_gauge");
		expect(family!.samples[0]!.labels.label).toBe(
			'value with "quotes" and \\backslash',
		);
	});

	test("groups families correctly", () => {
		const result = parsePrometheus(SAMPLE_METRICS);
		expect(result.families).toHaveLength(3);
	});
});

describe("getGaugeValues", () => {
	test("extracts gauge samples", () => {
		const metrics = parsePrometheus(SAMPLE_METRICS);
		const values = getGaugeValues(metrics, "boilerhouse_tenants_active");
		expect(values).toHaveLength(2);
		expect(values[0]!.value).toBe(5);
		expect(values[0]!.labels.workload).toBe("my-app");
	});

	test("returns empty for missing metric", () => {
		const metrics = parsePrometheus(SAMPLE_METRICS);
		const values = getGaugeValues(metrics, "nonexistent");
		expect(values).toHaveLength(0);
	});
});

describe("getCounterValues", () => {
	test("extracts counter totals", () => {
		const metrics = parsePrometheus(SAMPLE_METRICS);
		const values = getCounterValues(metrics, "boilerhouse_tenant_claims");
		expect(values).toHaveLength(3);
		expect(values[0]!.value).toBe(42);
	});

	test("returns empty for missing metric", () => {
		const metrics = parsePrometheus(SAMPLE_METRICS);
		const values = getCounterValues(metrics, "nonexistent");
		expect(values).toHaveLength(0);
	});
});

describe("computePercentile", () => {
	test("computes p50 from histogram buckets", () => {
		const metrics = parsePrometheus(SAMPLE_METRICS);
		const p50 = computePercentile(
			metrics,
			"boilerhouse_tenant_claim_duration_seconds",
			0.5,
		);
		// 50th percentile: 25 out of 50 observations
		// Bucket [0.1, 0.25] has 5 to 20 (15 observations)
		// We need 25 total, 25-5=20 into bucket [0.1,0.25] which has 15 obs
		// Actually: target = 25. bucket [0,0.05]=0, [0.05,0.1]=5, [0.1,0.25]=20
		// At le=0.25, cumCount=20. At le=0.5, cumCount=40.
		// Target 25 falls in [0.25, 0.5] bucket
		// Interpolation: 0.25 + (25-20)/(40-20) * (0.5-0.25) = 0.25 + 0.0625 = 0.3125
		expect(p50).toBeCloseTo(0.3125, 3);
	});

	test("computes p95 from histogram buckets", () => {
		const metrics = parsePrometheus(SAMPLE_METRICS);
		const p95 = computePercentile(
			metrics,
			"boilerhouse_tenant_claim_duration_seconds",
			0.95,
		);
		// 95th percentile: 47.5 out of 50
		// At le=0.5, cumCount=40. At le=1, cumCount=48.
		// Target 47.5 falls in [0.5, 1] bucket
		// Interpolation: 0.5 + (47.5-40)/(48-40) * (1-0.5) = 0.5 + 0.46875 = 0.96875
		expect(p95).toBeCloseTo(0.96875, 3);
	});

	test("returns null for missing metric", () => {
		const metrics = parsePrometheus(SAMPLE_METRICS);
		const result = computePercentile(metrics, "nonexistent", 0.5);
		expect(result).toBeNull();
	});

	test("handles filter labels", () => {
		const metrics = parsePrometheus(SAMPLE_METRICS);
		const p50 = computePercentile(
			metrics,
			"boilerhouse_tenant_claim_duration_seconds",
			0.5,
			{ workload: "my-app" },
		);
		expect(p50).toBeCloseTo(0.3125, 3);
	});

	test("returns null when no buckets match filter", () => {
		const metrics = parsePrometheus(SAMPLE_METRICS);
		const result = computePercentile(
			metrics,
			"boilerhouse_tenant_claim_duration_seconds",
			0.5,
			{ workload: "nonexistent" },
		);
		expect(result).toBeNull();
	});
});

describe("groupByLabel", () => {
	test("groups samples by label value", () => {
		const metrics = parsePrometheus(SAMPLE_METRICS);
		const values = getCounterValues(metrics, "boilerhouse_tenant_claims");
		const grouped = groupByLabel(values, "source");
		expect(grouped.get("golden")).toHaveLength(2);
		expect(grouped.get("snapshot")).toHaveLength(1);
	});

	test("handles missing label key", () => {
		const metrics = parsePrometheus(SAMPLE_METRICS);
		const values = getGaugeValues(metrics, "boilerhouse_tenants_active");
		const grouped = groupByLabel(values, "nonexistent");
		// All samples grouped under empty string
		expect(grouped.get("")).toHaveLength(2);
	});
});
