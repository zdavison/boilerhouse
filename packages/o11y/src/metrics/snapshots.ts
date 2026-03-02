import type { Meter, Counter, Histogram, ObservableGauge } from "@opentelemetry/api";

export interface SnapshotMetrics {
	createDuration: Histogram;
	creates: Counter;
	goldenQueueDepth: ObservableGauge;
	diskTotal: ObservableGauge;
	diskAvgPerTenant: ObservableGauge;
	snapshotCount: ObservableGauge;
}

export interface SnapshotMetricsDeps {
	/** Returns the current golden creator queue depth. */
	getGoldenQueueDepth: () => number;
	/** Returns total snapshot disk usage grouped by workload and type. */
	getDiskTotals: () => Array<{ workload: string; type: string; bytes: number }>;
	/** Returns average snapshot size per tenant grouped by workload. */
	getDiskAvgPerTenant: () => Array<{ workload: string; bytes: number }>;
	/** Returns snapshot counts grouped by workload and type. */
	getSnapshotCounts: () => Array<{ workload: string; type: string; count: number }>;
}

/**
 * Registers snapshot metrics on the given meter.
 *
 * - `boilerhouse.snapshot.create.duration` — Histogram of snapshot creation time
 * - `boilerhouse.snapshot.creates` — Counter of snapshot creation attempts
 * - `boilerhouse.golden.queue_depth` — Observable gauge of golden queue depth
 * - `boilerhouse.snapshot.disk.total` — Observable gauge of total snapshot disk usage
 * - `boilerhouse.snapshot.disk.avg_per_tenant` — Observable gauge of avg snapshot size per tenant
 * - `boilerhouse.snapshot.count` — Observable gauge of snapshot counts
 */
export function instrumentSnapshots(meter: Meter, deps: SnapshotMetricsDeps): SnapshotMetrics {
	const createDuration = meter.createHistogram("boilerhouse.snapshot.create.duration", {
		description: "Snapshot creation latency",
		unit: "s",
		advice: {
			explicitBucketBoundaries: [1, 5, 10, 30, 60, 120, 300],
		},
	});

	const creates = meter.createCounter("boilerhouse.snapshot.creates", {
		description: "Total snapshot creation attempts",
	});

	const goldenQueueDepth = meter.createObservableGauge("boilerhouse.golden.queue_depth", {
		description: "Golden creator queue depth",
	});

	goldenQueueDepth.addCallback((result) => {
		result.observe(deps.getGoldenQueueDepth());
	});

	const diskTotal = meter.createObservableGauge("boilerhouse.snapshot.disk.total", {
		description: "Total snapshot disk usage",
		unit: "By",
	});

	diskTotal.addCallback((result) => {
		for (const { workload, type, bytes } of deps.getDiskTotals()) {
			result.observe(bytes, { workload, type });
		}
	});

	const diskAvgPerTenant = meter.createObservableGauge("boilerhouse.snapshot.disk.avg_per_tenant", {
		description: "Average snapshot disk usage per tenant",
		unit: "By",
	});

	diskAvgPerTenant.addCallback((result) => {
		for (const { workload, bytes } of deps.getDiskAvgPerTenant()) {
			result.observe(bytes, { workload });
		}
	});

	const snapshotCount = meter.createObservableGauge("boilerhouse.snapshot.count", {
		description: "Total snapshot count",
	});

	snapshotCount.addCallback((result) => {
		for (const { workload, type, count } of deps.getSnapshotCounts()) {
			result.observe(count, { workload, type });
		}
	});

	return { createDuration, creates, goldenQueueDepth, diskTotal, diskAvgPerTenant, snapshotCount };
}
