import type { Meter, ObservableGauge } from "@opentelemetry/api";

export interface CapacityMetrics {
	max: ObservableGauge;
	used: ObservableGauge;
	queueDepth: ObservableGauge;
}

export interface CapacityMetricsDeps {
	/** Returns per-node capacity limits. */
	getCapacityMax: () => Array<{ node: string; max: number }>;
	/** Returns per-node active instance counts. */
	getCapacityUsed: () => Array<{ node: string; used: number }>;
	/** Returns per-node queue depths. */
	getQueueDepths: () => Array<{ node: string; depth: number }>;
}

/**
 * Registers capacity metrics on the given meter.
 *
 * - `boilerhouse.node.capacity.max` — Observable gauge of max instance capacity per node
 * - `boilerhouse.node.capacity.used` — Observable gauge of used capacity per node
 * - `boilerhouse.capacity.queue_depth` — Observable gauge of queue depth per node
 */
export function instrumentCapacity(meter: Meter, deps: CapacityMetricsDeps): CapacityMetrics {
	const max = meter.createObservableGauge("boilerhouse.node.capacity.max", {
		description: "Maximum instance capacity per node",
	});

	max.addCallback((result) => {
		for (const { node, max: maxVal } of deps.getCapacityMax()) {
			result.observe(maxVal, { node });
		}
	});

	const used = meter.createObservableGauge("boilerhouse.node.capacity.used", {
		description: "Used instance capacity per node",
	});

	used.addCallback((result) => {
		for (const { node, used: usedVal } of deps.getCapacityUsed()) {
			result.observe(usedVal, { node });
		}
	});

	const queueDepth = meter.createObservableGauge("boilerhouse.capacity.queue_depth", {
		description: "Capacity wait queue depth per node",
	});

	queueDepth.addCallback((result) => {
		for (const { node, depth } of deps.getQueueDepths()) {
			result.observe(depth, { node });
		}
	});

	return { max, used, queueDepth };
}
