import type { Meter, Counter, ObservableGauge } from "@opentelemetry/api";

export interface InstanceMetrics {
	instances: ObservableGauge;
	transitions: Counter;
	idleTimeouts: Counter;
}

export interface InstanceMetricsDeps {
	/** Returns instance counts grouped by workload, node, and status. */
	getInstanceCounts: () => Array<{ workload: string; node: string; status: string; count: number }>;
}

/**
 * Registers instance metrics on the given meter.
 *
 * - `boilerhouse.instances` — Observable gauge of instances by status
 * - `boilerhouse.instance.transitions` — Counter of state transitions
 * - `boilerhouse.idle.timeouts` — Counter of idle timeout events
 */
export function instrumentInstances(meter: Meter, deps: InstanceMetricsDeps): InstanceMetrics {
	const instances = meter.createObservableGauge("boilerhouse.instances", {
		description: "Instance count by status",
	});

	instances.addCallback((result) => {
		for (const { workload, node, status, count } of deps.getInstanceCounts()) {
			result.observe(count, { workload, node, status });
		}
	});

	const transitions = meter.createCounter("boilerhouse.instance.transitions", {
		description: "Instance state transitions",
	});

	const idleTimeouts = meter.createCounter("boilerhouse.idle.timeouts", {
		description: "Idle timeout events",
	});

	return { instances, transitions, idleTimeouts };
}
