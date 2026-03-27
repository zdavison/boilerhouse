import * as os from "node:os";
import * as fs from "node:fs";
import { execSync } from "node:child_process";
import type { Meter, ObservableGauge } from "@opentelemetry/api";

export interface NodeMetrics {
	systemCpuCount: ObservableGauge;
	systemMemTotal: ObservableGauge;
	systemMemAvailable: ObservableGauge;
	systemCpuUsage: ObservableGauge;
	containerCpu: ObservableGauge;
	containerMem: ObservableGauge;
}

export interface ContainerSnapshot {
	instanceId: string;
	workload: string;
	tenant: string;
	cpuFraction: number;
	memoryBytes: number;
}

export interface NodeMetricsDeps {
	/** Returns current container resource snapshots. */
	getContainerStats: () => ContainerSnapshot[];
}

// ── Platform-specific helpers ─────────────────────────────────────────────

/** Returns actually available memory in bytes (not just "free" pages). */
function getAvailableMemory(): number {
	if (process.platform === "darwin") {
		try {
			const vmstat = execSync("vm_stat", { encoding: "utf8", timeout: 2000 });
			const pageSize = 16384;
			const get = (label: string) => {
				const m = vmstat.match(new RegExp(label + ":\\s+(\\d+)"));
				return m ? parseInt(m[1]!) * pageSize : 0;
			};
			return get("Pages free") + get("Pages inactive") + get("Pages purgeable");
		} catch {
			return os.freemem();
		}
	}
	if (process.platform === "linux") {
		try {
			const meminfo = fs.readFileSync("/proc/meminfo", "utf8");
			const m = meminfo.match(/MemAvailable:\s+(\d+)/);
			if (m) return parseInt(m[1]!) * 1024;
		} catch {
			// fall through
		}
	}
	return os.freemem();
}

/**
 * Measures actual CPU utilization by sampling os.cpus() over a short interval.
 * Returns a fraction 0.0–1.0. Caches the last measurement and samples every 5s.
 */
let _cpuUsage = 0;
let _prevCpus = os.cpus();
function pollCpuUsage(): void {
	const now = os.cpus();
	let totalIdle = 0;
	let totalTick = 0;
	for (let i = 0; i < now.length; i++) {
		const prev = _prevCpus[i];
		const cur = now[i]!;
		if (!prev) continue;
		const idle = cur.times.idle - prev.times.idle;
		const total =
			(cur.times.user - prev.times.user) +
			(cur.times.nice - prev.times.nice) +
			(cur.times.sys - prev.times.sys) +
			(cur.times.irq - prev.times.irq) +
			idle;
		totalIdle += idle;
		totalTick += total;
	}
	_cpuUsage = totalTick > 0 ? 1 - totalIdle / totalTick : 0;
	_prevCpus = now;
}

// Sample CPU every 5 seconds
setInterval(pollCpuUsage, 5000);
// Take initial sample after 1s so first scrape has data
setTimeout(pollCpuUsage, 1000);

// ── Metric registration ───────────────────────────────────────────────────

/**
 * Registers node and container resource metrics on the given meter.
 *
 * - `boilerhouse.system.cpus` — Number of logical CPUs
 * - `boilerhouse.system.mem.capacity` — Total system memory (bytes)
 * - `boilerhouse.system.mem.available` — Available system memory (bytes)
 * - `boilerhouse.system.cpu.usage` — System CPU utilization (0.0–1.0)
 * - `boilerhouse.container.cpu` — Per-container CPU usage (fraction)
 * - `boilerhouse.container.mem` — Per-container memory usage (bytes)
 */
export function instrumentNode(meter: Meter, deps: NodeMetricsDeps): NodeMetrics {
	const systemCpuCount = meter.createObservableGauge("boilerhouse.system.cpus", {
		description: "Number of logical CPUs",
	});
	systemCpuCount.addCallback((result) => {
		result.observe(os.cpus().length);
	});

	const systemMemTotal = meter.createObservableGauge("boilerhouse.system.mem.capacity", {
		description: "Total system memory",
		unit: "By",
	});
	systemMemTotal.addCallback((result) => {
		result.observe(os.totalmem());
	});

	const systemMemAvailable = meter.createObservableGauge("boilerhouse.system.mem.available", {
		description: "Available system memory (free + reclaimable)",
		unit: "By",
	});
	systemMemAvailable.addCallback((result) => {
		result.observe(getAvailableMemory());
	});

	const systemCpuUsage = meter.createObservableGauge("boilerhouse.system.cpu.usage", {
		description: "System CPU utilization (0.0-1.0)",
	});
	systemCpuUsage.addCallback((result) => {
		result.observe(_cpuUsage);
	});

	const containerCpu = meter.createObservableGauge("boilerhouse.container.cpu", {
		description: "Container CPU usage (fraction of one core)",
	});
	containerCpu.addCallback((result) => {
		for (const c of deps.getContainerStats()) {
			result.observe(c.cpuFraction, {
				instance_id: c.instanceId,
				workload: c.workload,
				tenant: c.tenant,
			});
		}
	});

	const containerMem = meter.createObservableGauge("boilerhouse.container.mem", {
		description: "Container memory usage",
		unit: "By",
	});
	containerMem.addCallback((result) => {
		for (const c of deps.getContainerStats()) {
			result.observe(c.memoryBytes, {
				instance_id: c.instanceId,
				workload: c.workload,
				tenant: c.tenant,
			});
		}
	});

	return { systemCpuCount, systemMemTotal, systemMemAvailable, systemCpuUsage, containerCpu, containerMem };
}
