import { test, expect, describe } from "bun:test";
import { MeterProvider, InMemoryMetricExporter, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { DataPointType } from "@opentelemetry/sdk-metrics";
import { instrumentPool } from "./pool";

/** Creates an in-memory MeterProvider + reader for testing. */
function createTestMeter() {
	const exporter = new InMemoryMetricExporter(0 /* CUMULATIVE */);
	const reader = new PeriodicExportingMetricReader({
		exporter,
		exportIntervalMillis: 60_000, // won't fire automatically
	});
	const provider = new MeterProvider({ readers: [reader] });
	const meter = provider.getMeter("test");

	async function collect() {
		const result = await reader.collect();
		return result?.resourceMetrics.scopeMetrics.flatMap((sm) => sm.metrics) ?? [];
	}

	return { meter, collect };
}

describe("instrumentPool", () => {
	test("pool_depth gauge emits one observation per workload", async () => {
		const { meter, collect } = createTestMeter();

		instrumentPool(meter, {
			getPoolDepths: () => [
				{ workload: "my-app", depth: 3 },
				{ workload: "other-app", depth: 1 },
			],
		});

		const metrics = await collect();
		const poolDepth = metrics.find((m) => m.descriptor.name === "boilerhouse.pool.depth");
		expect(poolDepth).toBeDefined();
		expect(poolDepth!.dataPointType).toBe(DataPointType.GAUGE);
		expect(poolDepth!.dataPoints).toHaveLength(2);

		const appPoint = poolDepth!.dataPoints.find(
			(dp) => (dp.attributes as Record<string, string>).workload === "my-app",
		);
		expect(appPoint).toBeDefined();
		expect(appPoint!.value).toBe(3);
	});

	test("pool_depth gauge emits 0 when pool is empty (not omitted)", async () => {
		const { meter, collect } = createTestMeter();

		instrumentPool(meter, {
			getPoolDepths: () => [{ workload: "empty-app", depth: 0 }],
		});

		const metrics = await collect();
		const poolDepth = metrics.find((m) => m.descriptor.name === "boilerhouse.pool.depth");
		expect(poolDepth).toBeDefined();
		expect(poolDepth!.dataPoints).toHaveLength(1);
		expect(poolDepth!.dataPoints[0]!.value).toBe(0);
	});
});
