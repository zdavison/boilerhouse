import type { Meter, Counter, Histogram, ObservableGauge } from "@opentelemetry/api";

export interface TenantMetrics {
	claimDuration: Histogram;
	claims: Counter;
	releases: Counter;
	active: ObservableGauge;
	usageSeconds: Counter;
	overlayDisk: ObservableGauge;
}

export interface TenantMetricsDeps {
	/** Returns active tenant counts grouped by workloadId. */
	getActiveCounts: () => Array<{ workload: string; count: number }>;
	/** Returns per-tenant overlay disk usage in bytes. */
	getOverlaySizes: () => Array<{ tenant: string; workload: string; bytes: number }>;
}

/**
 * Registers tenant metrics on the given meter.
 *
 * - `boilerhouse.tenant.claim.duration` — Histogram of claim latency in seconds
 * - `boilerhouse.tenant.claims` — Counter of tenant claims
 * - `boilerhouse.tenant.releases` — Counter of tenant releases
 * - `boilerhouse.tenants.active` — Observable gauge of active tenants
 */
export function instrumentTenants(meter: Meter, deps: TenantMetricsDeps): TenantMetrics {
	const claimDuration = meter.createHistogram("boilerhouse.tenant.claim.duration", {
		description: "Tenant claim latency",
		unit: "s",
		advice: {
			explicitBucketBoundaries: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
		},
	});

	const claims = meter.createCounter("boilerhouse.tenant.claims", {
		description: "Total tenant claim attempts",
	});

	const releases = meter.createCounter("boilerhouse.tenant.releases", {
		description: "Total tenant releases",
	});

	const active = meter.createObservableGauge("boilerhouse.tenants.active", {
		description: "Currently active tenants",
	});

	active.addCallback((result) => {
		for (const { workload, count } of deps.getActiveCounts()) {
			result.observe(count, { workload });
		}
	});

	const usageSeconds = meter.createCounter("boilerhouse.tenant.usage", {
		description: "Total tenant usage time",
		unit: "s",
	});

	const overlayDisk = meter.createObservableGauge("boilerhouse.tenant.overlay.disk", {
		description: "Tenant overlay disk usage",
		unit: "By",
	});
	overlayDisk.addCallback((result) => {
		for (const { tenant, workload, bytes } of deps.getOverlaySizes()) {
			result.observe(bytes, { tenant, workload });
		}
	});

	return { claimDuration, claims, releases, active, usageSeconds, overlayDisk };
}
