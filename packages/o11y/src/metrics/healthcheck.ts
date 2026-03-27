import type { Meter, Counter, Histogram } from "@opentelemetry/api";

export interface HealthCheckMetrics {
	duration: Histogram;
	failures: Counter;
}

/**
 * Registers health check metrics on the given meter.
 *
 * - `boilerhouse.healthcheck.duration` — Histogram of time-to-healthy after create/restore
 * - `boilerhouse.healthcheck.failures` — Counter of health check timeouts
 */
export function instrumentHealthCheck(meter: Meter): HealthCheckMetrics {
	const duration = meter.createHistogram("boilerhouse.healthcheck.duration", {
		description: "Time from instance start to passing health check",
		unit: "s",
		advice: {
			explicitBucketBoundaries: [0.5, 1, 2, 5, 10, 30, 60, 120, 300],
		},
	});

	const failures = meter.createCounter("boilerhouse.healthcheck.failures", {
		description: "Health check timeout or failure count",
	});

	return { duration, failures };
}
