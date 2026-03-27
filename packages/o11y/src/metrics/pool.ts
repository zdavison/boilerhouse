import type { Meter, ObservableGauge, Histogram } from "@opentelemetry/api";

export interface PoolMetrics {
	poolDepth: ObservableGauge;
	coldStartDuration: Histogram;
}

export interface PoolMetricsDeps {
	/** Returns pool depth (count of ready instances) grouped by workload name. */
	getPoolDepths: () => Array<{ workload: string; depth: number }>;
}

/**
 * Registers pool metrics on the given meter.
 *
 * - `boilerhouse.pool.depth` — Observable gauge of ready pool instances per workload
 * - `boilerhouse.pool.cold_start.duration` — Histogram of cold start times per workload
 */
export function instrumentPool(meter: Meter, deps: PoolMetricsDeps): PoolMetrics {
	const poolDepth = meter.createObservableGauge("boilerhouse.pool.depth", {
		description: "Ready pool instance count per workload",
	});

	poolDepth.addCallback((result) => {
		for (const { workload, depth } of deps.getPoolDepths()) {
			result.observe(depth, { workload });
		}
	});

	const coldStartDuration = meter.createHistogram("boilerhouse.pool.cold_start.duration", {
		description: "Time from pool instance start to ready (seconds)",
		unit: "s",
		advice: { explicitBucketBoundaries: [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 40, 80, 160, 300] },
	});

	return { poolDepth, coldStartDuration };
}
