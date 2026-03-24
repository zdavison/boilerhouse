import type { Meter, ObservableGauge } from "@opentelemetry/api";

export interface PoolMetrics {
	poolDepth: ObservableGauge;
}

export interface PoolMetricsDeps {
	/** Returns pool depth (count of ready instances) grouped by workload name. */
	getPoolDepths: () => Array<{ workload: string; depth: number }>;
}

/**
 * Registers pool metrics on the given meter.
 *
 * - `boilerhouse.pool.depth` — Observable gauge of ready pool instances per workload
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

	return { poolDepth };
}
