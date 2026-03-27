import type { Meter, Counter, Histogram } from "@opentelemetry/api";

export interface TriggerMetrics {
	dispatches: Counter;
	dispatchDuration: Histogram;
}

/**
 * Registers trigger metrics on the given meter.
 *
 * - `boilerhouse.trigger.dispatches` — Counter of trigger dispatch attempts
 * - `boilerhouse.trigger.dispatch.duration` — Histogram of trigger dispatch latency
 *
 * The `boilerhouse.trigger.queue.depth` gauge is registered separately in
 * trigger-adapters.ts where the TriggerQueueManager is available.
 */
export function instrumentTriggers(meter: Meter): TriggerMetrics {
	const dispatches = meter.createCounter("boilerhouse.trigger.dispatches", {
		description: "Total trigger dispatch attempts",
	});

	const dispatchDuration = meter.createHistogram("boilerhouse.trigger.dispatch.duration", {
		description: "Trigger dispatch latency",
		unit: "s",
		advice: {
			explicitBucketBoundaries: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
		},
	});

	return { dispatches, dispatchDuration };
}
