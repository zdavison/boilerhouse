import { useState, useCallback, useRef, useEffect } from "react";
import { RefreshCw } from "lucide-react";
import {
	BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
	Cell, Legend, CartesianGrid, PieChart, Pie, ReferenceLine,
	LineChart, Line,
} from "recharts";
import { useApi, useAutoRefresh } from "../hooks";
import {
	fetchMetrics,
	fetchRange,
	getGaugeValues,
	getCounterValues,
	computePercentile,
	getHistogramAvg,
	type PrometheusMetrics,
	type PrometheusSample,
	type RangeSeriesPoint,
} from "../prometheus";
import {
	PageHeader,
	LoadingState,
	ErrorState,
} from "../components";

// ── Theme ──────────────────────────────────────────────────────────────────

const COLORS = {
	p50: "#3DD9B2",    // accent-bright / green
	p95: "#61AFEF",    // status-blue
	p99: "#C678DD",    // purple
	pool: "#3DD9B2",
	cold: "#E5C07B",   // status-yellow
	snapshot: "#D19A66", // status-orange
	existing: "#61AFEF",
	error: "#E06C75",   // status-red
	system: "#ffffff",
	grid: "#2A2637",
	text: "#9893A6",    // muted-light
	bg: "#1A1726",      // surface-2
	palette: ["#3DD9B2", "#61AFEF", "#C678DD", "#D19A66", "#E5C07B", "#E06C75", "#56B6C2", "#98C379"],
};

const REFRESH_OPTIONS = [
	{ label: "5s", ms: 5000 },
	{ label: "10s", ms: 10000 },
	{ label: "30s", ms: 30000 },
	{ label: "60s", ms: 60000 },
	{ label: "off", ms: 0 },
];

// ── Formatters ─────────────────────────────────────────────────────────────

function fmtDur(seconds: number): string {
	if (seconds < 0.001) return "<1ms";
	if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
	return `${seconds.toFixed(1)}s`;
}

function fmtBytes(bytes: number): string {
	if (bytes === 0) return "0 B";
	const units = ["B", "KB", "MB", "GB", "TB"];
	const i = Math.floor(Math.log(bytes) / Math.log(1024));
	return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function fmtPct(v: number): string {
	return `${(v * 100).toFixed(0)}%`;
}

function sumValues(samples: PrometheusSample[]): number {
	return samples.reduce((acc, s) => acc + s.value, 0);
}

// ── Shared components ──────────────────────────────────────────────────────

function SectionHeader({ children }: { children: React.ReactNode }) {
	return (
		<h3 className="text-base font-tight font-semibold mt-8 mb-3 text-muted-light">
			{children}
		</h3>
	);
}

function Stat({ label, value, sub, warn }: { label: string; value: string; sub?: string; warn?: boolean }) {
	return (
		<div className={`bg-surface-2 rounded-md p-4 ${warn ? "ring-1 ring-status-yellow/40" : ""}`}>
			<p className="text-xs text-muted">{label}</p>
			<p className={`text-2xl font-bold font-mono mt-0.5 ${warn ? "text-status-yellow" : ""}`}>{value}</p>
			{sub && <p className="text-xs text-muted mt-0.5">{sub}</p>}
		</div>
	);
}

function NoData() {
	return <div className="text-center py-4 text-muted text-sm font-mono">no data yet</div>;
}

const tooltipStyle = {
	contentStyle: { background: "#221F2E", border: "1px solid #2A2637", borderRadius: 6, fontSize: 12 },
	labelStyle: { color: "#9893A6" },
	itemStyle: { color: "#C8C5D0" },
};

// ── Time series buffer ─────────────────────────────────────────────────────

interface TimeSeriesPoint {
	time: string;
	[key: string]: string | number;
}

const MAX_POINTS = 60;

/**
 * Accumulates snapshots into a rolling time series buffer.
 * Seeds from Prometheus query_range on first mount so graphs appear instantly.
 */
function useTimeSeries(
	extract: (metrics: PrometheusMetrics) => Record<string, number>,
	metrics: PrometheusMetrics,
	key?: string,
	seed?: RangeSeriesPoint[],
): TimeSeriesPoint[] {
	const bufRef = useRef<TimeSeriesPoint[]>([]);
	const keyRef = useRef(key);
	const seededRef = useRef(false);

	// Seed from Prometheus history on first render (or when seed data arrives)
	useEffect(() => {
		if (seed && seed.length > 0 && !seededRef.current) {
			bufRef.current = seed.slice(-MAX_POINTS);
			seededRef.current = true;
		}
	}, [seed]);

	useEffect(() => {
		if (keyRef.current !== key) {
			bufRef.current = [];
			keyRef.current = key;
			seededRef.current = false;
		}
		const values = extract(metrics);
		const point: TimeSeriesPoint = {
			time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }),
			...values,
		};
		bufRef.current = [...bufRef.current.slice(-(MAX_POINTS - 1)), point];
	}, [metrics, key]); // eslint-disable-line react-hooks/exhaustive-deps

	return bufRef.current;
}

/** Fetches a Prometheus range query once on mount. */
function useRangeQuery(query: string, labelKey: string, key?: string): RangeSeriesPoint[] | undefined {
	const [data, setData] = useState<RangeSeriesPoint[] | undefined>();
	const queryRef = useRef("");

	useEffect(() => {
		const fullKey = `${query}::${key ?? ""}`;
		if (queryRef.current === fullKey) return;
		queryRef.current = fullKey;
		fetchRange(query, labelKey).then(setData).catch(() => {});
	}, [query, labelKey, key]);

	return data;
}

// ── Claim Latency ──────────────────────────────────────────────────────────

type LatencyMode = "avg" | "p50" | "p95" | "p99";

const LATENCY_MODES: { key: LatencyMode; label: string }[] = [
	{ key: "avg", label: "avg" },
	{ key: "p50", label: "p50" },
	{ key: "p95", label: "p95" },
	{ key: "p99", label: "p99" },
];

function extractTenantLatency(metrics: PrometheusMetrics, mode: LatencyMode): Record<string, number> {
	const family = metrics.byName.get("boilerhouse_tenant_claim_duration");
	if (!family) return {};

	const tenants = new Set<string>();
	for (const s of family.samples) {
		if (s.labels.tenant) tenants.add(s.labels.tenant);
	}

	const result: Record<string, number> = {};
	for (const tenant of tenants) {
		let val: number | null;
		if (mode === "avg") {
			val = getHistogramAvg(metrics, "boilerhouse_tenant_claim_duration", { tenant });
		} else {
			const pct = mode === "p50" ? 0.5 : mode === "p95" ? 0.95 : 0.99;
			val = computePercentile(metrics, "boilerhouse_tenant_claim_duration", pct, { tenant });
		}
		if (val !== null) result[tenant] = val;
	}
	return result;
}

function latencyPromQL(mode: LatencyMode): string {
	if (mode === "avg") {
		return 'rate(boilerhouse_tenant_claim_duration_sum[1m]) / rate(boilerhouse_tenant_claim_duration_count[1m])';
	}
	const q = mode === "p50" ? 0.5 : mode === "p95" ? 0.95 : 0.99;
	return `histogram_quantile(${q}, rate(boilerhouse_tenant_claim_duration_bucket[1m]))`;
}

function ClaimLatencySection({ metrics }: { metrics: PrometheusMetrics }) {
	const claims = getCounterValues(metrics, "boilerhouse_tenant_claims");
	const totalClaims = sumValues(claims);
	const errorClaims = sumValues(claims.filter((s) => s.labels.outcome === "error"));
	const [mode, setMode] = useState<LatencyMode>("p95");

	const seed = useRangeQuery(latencyPromQL(mode), "tenant", mode);
	const series = useTimeSeries((m) => extractTenantLatency(m, mode), metrics, mode, seed);

	// Discover tenant keys from the series
	const tenantKeys = new Set<string>();
	for (const point of series) {
		for (const k of Object.keys(point)) {
			if (k !== "time") tenantKeys.add(k);
		}
	}

	return (
		<>
			<div className="grid grid-cols-2 gap-3 mb-4">
				<Stat label="Total Claims" value={String(totalClaims)} />
				<Stat label="Error Rate" value={totalClaims > 0 ? fmtPct(errorClaims / totalClaims) : "--"} warn={errorClaims > 0} />
			</div>
			<div className="bg-surface-2 rounded-md p-4">
				<div className="flex items-center justify-between mb-2">
					<p className="text-xs text-muted">Claim latency per tenant over time</p>
					<div className="flex items-center gap-1 bg-surface-3 rounded px-1 py-0.5">
						{LATENCY_MODES.map((m) => (
							<button
								key={m.key}
								onClick={() => setMode(m.key)}
								className={`px-2 py-0.5 rounded text-xs font-mono transition-colors ${
									mode === m.key ? "bg-surface-2 text-white" : "text-muted hover:text-white"
								}`}
							>
								{m.label}
							</button>
						))}
					</div>
				</div>
				<ResponsiveContainer width="100%" height={220}>
					<LineChart data={series}>
						<CartesianGrid strokeDasharray="3 3" stroke={COLORS.grid} />
						<XAxis dataKey="time" tick={{ fill: COLORS.text, fontSize: 10 }} interval="preserveStartEnd" />
						<YAxis tick={{ fill: COLORS.text, fontSize: 11 }} tickFormatter={fmtDur} />
						<Tooltip {...tooltipStyle} cursor={false} formatter={(v: number) => fmtDur(v)} />
						<Legend wrapperStyle={{ fontSize: 11 }} />
						{[...tenantKeys].map((tenant, i) => (
							<Line
								key={tenant}
								type="monotone"
								dataKey={tenant}
								stroke={COLORS.palette[i % COLORS.palette.length]}
								strokeWidth={2}
								dot={false}
								connectNulls
							/>
						))}
					</LineChart>
				</ResponsiveContainer>
			</div>
		</>
	);
}

// ── Tenant Usage ───────────────────────────────────────────────────────────

function TenantUsageSection({ metrics }: { metrics: PrometheusMetrics }) {
	const usage = getCounterValues(metrics, "boilerhouse_tenant_usage");

	const seed = useRangeQuery("boilerhouse_tenant_usage_total", "tenant");
	const series = useTimeSeries((m) => {
		const samples = getCounterValues(m, "boilerhouse_tenant_usage");
		const byTenant = new Map<string, number>();
		for (const s of samples) {
			const t = s.labels.tenant ?? "";
			byTenant.set(t, (byTenant.get(t) ?? 0) + s.value);
		}
		return Object.fromEntries(byTenant);
	}, metrics, undefined, seed);

	if (usage.length === 0) return <NoData />;

	const tenantKeys = new Set<string>();
	for (const point of series) {
		for (const k of Object.keys(point)) {
			if (k !== "time") tenantKeys.add(k);
		}
	}

	return (
		<div className="bg-surface-2 rounded-md p-4">
			<p className="text-xs text-muted mb-2">Cumulative usage per tenant over time</p>
			<ResponsiveContainer width="100%" height={220}>
				<LineChart data={series}>
					<CartesianGrid strokeDasharray="3 3" stroke={COLORS.grid} />
					<XAxis dataKey="time" tick={{ fill: COLORS.text, fontSize: 10 }} interval="preserveStartEnd" />
					<YAxis tick={{ fill: COLORS.text, fontSize: 11 }} tickFormatter={fmtDur} />
					<Tooltip {...tooltipStyle} cursor={false} formatter={(v: number) => fmtDur(v)} />
					<Legend wrapperStyle={{ fontSize: 11 }} />
					{[...tenantKeys].map((tenant, i) => (
						<Line
							key={tenant}
							type="monotone"
							dataKey={tenant}
							stroke={COLORS.palette[i % COLORS.palette.length]}
							strokeWidth={2}
							dot={false}
							connectNulls
						/>
					))}
				</LineChart>
			</ResponsiveContainer>
		</div>
	);
}

// ── Cold Starts ────────────────────────────────────────────────────────────

function ColdStartsSection({ metrics }: { metrics: PrometheusMetrics }) {
	const claims = getCounterValues(metrics, "boilerhouse_tenant_claims");
	const totalClaims = sumValues(claims);

	// Group by source
	const bySource = new Map<string, number>();
	for (const s of claims) {
		const src = s.labels.source ?? "unknown";
		bySource.set(src, (bySource.get(src) ?? 0) + s.value);
	}

	const poolClaims = bySource.get("pool") ?? 0;
	const existingClaims = bySource.get("existing") ?? 0;
	const coldStarts = totalClaims - poolClaims - existingClaims;
	const hitRate = totalClaims > 0 ? poolClaims / totalClaims : 0;
	const poolDepth = sumValues(getGaugeValues(metrics, "boilerhouse_pool_depth"));
	const coldStartAvg = getHistogramAvg(metrics, "boilerhouse_pool_cold_start_duration");

	const pieData = [...bySource.entries()].map(([name, value]) => ({ name, value }));
	const sourceColors: Record<string, string> = {
		pool: COLORS.pool, cold: COLORS.cold, "cold+data": COLORS.cold,
		snapshot: COLORS.snapshot, existing: COLORS.existing,
	};

	return (
		<div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
			<div className="grid grid-cols-2 gap-3">
				<Stat label="Cold Starts" value={String(coldStarts)} warn={coldStarts > 0} />
				<Stat label="Pool Hit Rate" value={fmtPct(hitRate)} warn={hitRate < 0.9 && totalClaims > 0} />
				<Stat label="Pool Depth" value={String(poolDepth)} />
				<Stat label="Cold Start avg" value={coldStartAvg !== null ? fmtDur(coldStartAvg) : "--"} />
			</div>
			{pieData.length > 0 && (
				<div className="bg-surface-2 rounded-md p-4 flex items-center justify-center">
					<ResponsiveContainer width="100%" height={180}>
						<PieChart>
							<Pie
								activeIndex={-1}
								data={pieData}
								dataKey="value"
								nameKey="name"
								cx="50%"
								cy="50%"
								innerRadius={40}
								outerRadius={70}
								paddingAngle={2}
								label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
								labelLine={false}
								style={{ fontSize: 11, fill: COLORS.text }}
							>
								{pieData.map((d, i) => (
									<Cell key={i} fill={sourceColors[d.name] ?? COLORS.palette[i % COLORS.palette.length]} />
								))}
							</Pie>
							<Tooltip {...tooltipStyle} cursor={false} />
						</PieChart>
					</ResponsiveContainer>
				</div>
			)}
		</div>
	);
}

// ── Tenant Data Storage ───────────────────────────────────────────────────

function TenantDataSection({ metrics }: { metrics: PrometheusMetrics }) {
	const overlays = getGaugeValues(metrics, "boilerhouse_tenant_overlay_disk");
	const totalBytes = sumValues(overlays);

	const seed = useRangeQuery("boilerhouse_tenant_overlay_disk", "tenant");
	const series = useTimeSeries((m) => {
		const samples = getGaugeValues(m, "boilerhouse_tenant_overlay_disk");
		const byTenant = new Map<string, number>();
		for (const s of samples) {
			const t = s.labels.tenant ?? "";
			byTenant.set(t, (byTenant.get(t) ?? 0) + s.value);
		}
		return Object.fromEntries(byTenant);
	}, metrics, undefined, seed);

	const tenantKeys = new Set<string>();
	for (const point of series) {
		for (const k of Object.keys(point)) {
			if (k !== "time") tenantKeys.add(k);
		}
	}

	if (overlays.length === 0 && series.length === 0) return <NoData />;

	return (
		<>
			<div className="grid grid-cols-3 gap-3 mb-4">
				<Stat label="Total Stored Data" value={fmtBytes(totalBytes)} />
				<Stat label="Tenants with Data" value={String(overlays.length)} />
				<Stat label="Avg per Tenant" value={overlays.length > 0 ? fmtBytes(totalBytes / overlays.length) : "--"} />
			</div>
			<div className="bg-surface-2 rounded-md p-4">
				<p className="text-xs text-muted mb-2">Persisted data per tenant over time</p>
				<ResponsiveContainer width="100%" height={220}>
					<LineChart data={series}>
						<CartesianGrid strokeDasharray="3 3" stroke={COLORS.grid} />
						<XAxis dataKey="time" tick={{ fill: COLORS.text, fontSize: 10 }} interval="preserveStartEnd" />
						<YAxis tick={{ fill: COLORS.text, fontSize: 11 }} tickFormatter={fmtBytes} />
						<Tooltip {...tooltipStyle} cursor={false} formatter={(v: number) => fmtBytes(v)} />
						<Legend wrapperStyle={{ fontSize: 11 }} />
						{[...tenantKeys].map((tenant, i) => (
							<Line
								key={tenant}
								type="monotone"
								dataKey={tenant}
								stroke={COLORS.palette[i % COLORS.palette.length]}
								strokeWidth={2}
								dot={false}
								connectNulls
							/>
						))}
					</LineChart>
				</ResponsiveContainer>
			</div>
		</>
	);
}

// ── Node Resources ─────────────────────────────────────────────────────────

function NodeResourcesSection({ metrics }: { metrics: PrometheusMetrics }) {
	const cpuCount = getGaugeValues(metrics, "boilerhouse_system_cpus")[0]?.value ?? 0;
	const memTotal = getGaugeValues(metrics, "boilerhouse_system_mem_capacity")[0]?.value ?? 0;
	const memAvailable = getGaugeValues(metrics, "boilerhouse_system_mem_available")[0]?.value ?? 0;
	const cpuUsage = getGaugeValues(metrics, "boilerhouse_system_cpu_usage")[0]?.value ?? 0;
	const containerCpu = getGaugeValues(metrics, "boilerhouse_container_cpu");
	const containerMem = getGaugeValues(metrics, "boilerhouse_container_mem");

	if (cpuCount === 0 && containerCpu.length === 0) return <NoData />;

	// Deduplicate by instance_id (take latest observation)
	const dedupMem = [...new Map(containerMem.map((s) => [s.labels.instance_id, s])).values()];
	const dedupCpu = [...new Map(containerCpu.map((s) => [s.labels.instance_id, s])).values()];

	const containerMemTotal = sumValues(dedupMem);
	const containerCount = dedupMem.length;

	// Group by tenant, with workloads as stacked segments
	const workloadSet = new Set<string>();
	for (const s of dedupMem) workloadSet.add(s.labels.workload ?? "unknown");
	for (const s of dedupCpu) workloadSet.add(s.labels.workload ?? "unknown");
	const workloads = [...workloadSet];

	// Build per-tenant memory data: { tenant, workloadA: bytes, workloadB: bytes }
	const memByTenant = new Map<string, Record<string, number>>();
	for (const s of dedupMem) {
		const tenant = s.labels.tenant || "(pool)";
		const workload = s.labels.workload ?? "unknown";
		const row = memByTenant.get(tenant) ?? {};
		row[workload] = (row[workload] ?? 0) + s.value;
		memByTenant.set(tenant, row);
	}
	const memData = [...memByTenant.entries()]
		.map(([tenant, wMap]) => ({ tenant, ...wMap }))
		.sort((a, b) => {
			const totalA = workloads.reduce((sum, w) => sum + ((a as Record<string, number>)[w] ?? 0), 0);
			const totalB = workloads.reduce((sum, w) => sum + ((b as Record<string, number>)[w] ?? 0), 0);
			return totalB - totalA;
		});

	// Build per-tenant CPU data
	const cpuByTenant = new Map<string, Record<string, number>>();
	for (const s of dedupCpu) {
		const tenant = s.labels.tenant || "(pool)";
		const workload = s.labels.workload ?? "unknown";
		const row = cpuByTenant.get(tenant) ?? {};
		row[workload] = (row[workload] ?? 0) + s.value * 100;
		cpuByTenant.set(tenant, row);
	}
	const cpuData = [...cpuByTenant.entries()]
		.map(([tenant, wMap]) => ({ tenant, ...wMap }))
		.sort((a, b) => {
			const totalA = workloads.reduce((sum, w) => sum + ((a as Record<string, number>)[w] ?? 0), 0);
			const totalB = workloads.reduce((sum, w) => sum + ((b as Record<string, number>)[w] ?? 0), 0);
			return totalB - totalA;
		});

	return (
		<>
			<div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 mb-4">
				<Stat
					label="System Memory"
					value={memTotal > 0 ? `${fmtBytes(memAvailable)} available` : "--"}
					sub={`${fmtBytes(memTotal)} total`}
					warn={memTotal > 0 && memAvailable < memTotal * 0.1}
				/>
				<Stat
					label="Container Memory"
					value={fmtBytes(containerMemTotal)}
					sub={`${containerCount} containers`}
				/>
				<Stat
					label="CPU Usage"
					value={`${(cpuUsage * 100).toFixed(0)}%`}
					sub={`${cpuCount} CPUs`}
					warn={cpuUsage > 0.9}
				/>
				<Stat
					label="Avg per Container"
					value={containerCount > 0 ? fmtBytes(containerMemTotal / containerCount) : "--"}
				/>
			</div>
			<div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
				{memData.length > 0 && (
					<div className="bg-surface-2 rounded-md p-4">
						<p className="text-xs text-muted mb-2">Memory per tenant (total: {fmtBytes(memTotal)})</p>
						<ResponsiveContainer width="100%" height={Math.max(150, memData.length * 32)}>
							<BarChart data={memData} layout="vertical" barSize={18}>
								<CartesianGrid strokeDasharray="3 3" stroke={COLORS.grid} horizontal={false} />
								<XAxis type="number" tick={{ fill: COLORS.text, fontSize: 11 }} tickFormatter={fmtBytes} domain={[0, memTotal > 0 ? memTotal : "auto"]} />
								<YAxis dataKey="tenant" type="category" width={140} tick={{ fill: COLORS.text, fontSize: 10 }} />
								<Tooltip {...tooltipStyle} cursor={false} formatter={(v: number) => fmtBytes(v)} />
								{workloads.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
								{memTotal > 0 && (
									<ReferenceLine x={memTotal} stroke="rgba(255,255,255,0.4)" strokeDasharray="6 3" strokeWidth={2} ifOverflow="extendDomain" />
								)}
								{workloads.map((w, i) => (
									<Bar activeBar={false} key={w} dataKey={w} stackId="mem" fill={COLORS.palette[i % COLORS.palette.length]}
										radius={i === workloads.length - 1 ? [0, 4, 4, 0] : undefined} />
								))}
							</BarChart>
						</ResponsiveContainer>
					</div>
				)}
				{cpuData.length > 0 && (
					<div className="bg-surface-2 rounded-md p-4">
						<p className="text-xs text-muted mb-2">CPU per tenant (system: {(cpuUsage * 100).toFixed(0)}% of {cpuCount} CPUs)</p>
						<ResponsiveContainer width="100%" height={Math.max(150, cpuData.length * 32)}>
							<BarChart data={cpuData} layout="vertical" barSize={18}>
								<CartesianGrid strokeDasharray="3 3" stroke={COLORS.grid} horizontal={false} />
								<XAxis type="number" tick={{ fill: COLORS.text, fontSize: 11 }} unit="%" />
								<YAxis dataKey="tenant" type="category" width={140} tick={{ fill: COLORS.text, fontSize: 10 }} />
								<Tooltip {...tooltipStyle} cursor={false} formatter={(v: number) => `${v.toFixed(1)}%`} />
								{workloads.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
								{workloads.map((w, i) => (
									<Bar activeBar={false} key={w} dataKey={w} stackId="cpu" fill={COLORS.palette[i % COLORS.palette.length]}
										radius={i === workloads.length - 1 ? [0, 4, 4, 0] : undefined} />
								))}
							</BarChart>
						</ResponsiveContainer>
					</div>
				)}
			</div>
		</>
	);
}


// ── Trigger Queues ─────────────────────────────────────────────────────────

function TriggerQueuesSection({ metrics }: { metrics: PrometheusMetrics }) {
	const depths = getGaugeValues(metrics, "boilerhouse_trigger_queue_depth");

	const waiting = sumValues(depths.filter((s) => s.labels.state === "waiting"));
	const active = sumValues(depths.filter((s) => s.labels.state === "active"));
	const delayed = sumValues(depths.filter((s) => s.labels.state === "delayed"));

	// Build per-trigger breakdown
	const byTrigger = new Map<string, { waiting: number; active: number; delayed: number }>();
	for (const s of depths) {
		const trigger = s.labels.trigger ?? "unknown";
		const entry = byTrigger.get(trigger) ?? { waiting: 0, active: 0, delayed: 0 };
		const state = s.labels.state as "waiting" | "active" | "delayed";
		if (state in entry) entry[state] += s.value;
		byTrigger.set(trigger, entry);
	}

	const barData = [...byTrigger.entries()]
		.map(([trigger, counts]) => ({ trigger, ...counts }))
		.sort((a, b) => (b.waiting + b.delayed) - (a.waiting + a.delayed));

	const seed = useRangeQuery(
		"sum by (trigger) (boilerhouse_trigger_queue_depth{state=\"waiting\"})",
		"trigger",
	);
	const series = useTimeSeries((m) => {
		const samples = getGaugeValues(m, "boilerhouse_trigger_queue_depth")
			.filter((s) => s.labels.state === "waiting");
		const byT = new Map<string, number>();
		for (const s of samples) {
			const t = s.labels.trigger ?? "unknown";
			byT.set(t, (byT.get(t) ?? 0) + s.value);
		}
		return Object.fromEntries(byT);
	}, metrics, undefined, seed);

	const triggerKeys = new Set<string>();
	for (const point of series) {
		for (const k of Object.keys(point)) {
			if (k !== "time") triggerKeys.add(k);
		}
	}

	if (depths.length === 0 && series.length === 0) return <NoData />;

	return (
		<>
			<div className="grid grid-cols-3 gap-3 mb-4">
				<Stat label="Waiting" value={String(waiting)} warn={waiting > 10} />
				<Stat label="Active" value={String(active)} />
				<Stat label="Delayed" value={String(delayed)} warn={delayed > 5} />
			</div>
			<div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
				{barData.length > 0 && (
					<div className="bg-surface-2 rounded-md p-4">
						<p className="text-xs text-muted mb-2">Queue depth by trigger</p>
						<ResponsiveContainer width="100%" height={Math.max(150, barData.length * 32)}>
							<BarChart data={barData} layout="vertical" barSize={18}>
								<CartesianGrid strokeDasharray="3 3" stroke={COLORS.grid} horizontal={false} />
								<XAxis type="number" tick={{ fill: COLORS.text, fontSize: 11 }} />
								<YAxis dataKey="trigger" type="category" width={140} tick={{ fill: COLORS.text, fontSize: 10 }} />
								<Tooltip {...tooltipStyle} cursor={false} />
								<Legend wrapperStyle={{ fontSize: 11 }} />
								<Bar activeBar={false} dataKey="waiting" stackId="q" fill={COLORS.cold} name="waiting" />
								<Bar activeBar={false} dataKey="active" stackId="q" fill={COLORS.pool} name="active" />
								<Bar activeBar={false} dataKey="delayed" stackId="q" fill={COLORS.error} name="delayed" radius={[0, 4, 4, 0]} />
							</BarChart>
						</ResponsiveContainer>
					</div>
				)}
				{series.length > 0 && (
					<div className="bg-surface-2 rounded-md p-4">
						<p className="text-xs text-muted mb-2">Waiting jobs over time</p>
						<ResponsiveContainer width="100%" height={Math.max(150, barData.length * 32)}>
							<LineChart data={series}>
								<CartesianGrid strokeDasharray="3 3" stroke={COLORS.grid} />
								<XAxis dataKey="time" tick={{ fill: COLORS.text, fontSize: 10 }} interval="preserveStartEnd" />
								<YAxis tick={{ fill: COLORS.text, fontSize: 11 }} />
								<Tooltip {...tooltipStyle} cursor={false} />
								<Legend wrapperStyle={{ fontSize: 11 }} />
								{[...triggerKeys].map((trigger, i) => (
									<Line
										key={trigger}
										type="monotone"
										dataKey={trigger}
										stroke={COLORS.palette[i % COLORS.palette.length]}
										strokeWidth={2}
										dot={false}
										connectNulls
									/>
								))}
							</LineChart>
						</ResponsiveContainer>
					</div>
				)}
			</div>
		</>
	);
}

// ── Main Page ──────────────────────────────────────────────────────────────

export function MetricsPage() {
	const { data: metrics, loading, error, refetch } = useApi(fetchMetrics);
	const [lastUpdated, setLastUpdated] = useState<string | null>(null);
	const [rawOpen, setRawOpen] = useState(false);
	const [rawText, setRawText] = useState<string | null>(null);

	const refresh = useCallback(() => {
		refetch();
		setLastUpdated(new Date().toLocaleTimeString());
		fetch("/metrics")
			.then((r) => r.text())
			.then(setRawText)
			.catch(() => setRawText(null));
	}, [refetch]);

	const autoRefresh = useAutoRefresh(refresh, 10000);

	if (loading && !metrics) return <LoadingState />;
	if (error) {
		return (
			<div>
				<PageHeader>metrics</PageHeader>
				<ErrorState message="Cannot reach metrics endpoint. Is the API server running with metrics enabled?" />
			</div>
		);
	}
	if (!metrics) return null;

	return (
		<div>
			<div className="flex items-center justify-between mb-6">
				<PageHeader>metrics</PageHeader>
				<div className="flex items-center gap-3 text-sm font-mono">
					{lastUpdated && (
						<span className="text-muted text-xs">updated {lastUpdated}</span>
					)}
					<div className="flex items-center gap-1 bg-surface-2 rounded px-2 py-1">
						{REFRESH_OPTIONS.map((opt) => (
							<button
								key={opt.ms}
								onClick={() => {
									autoRefresh.setInterval(opt.ms);
									autoRefresh.setPaused(opt.ms === 0);
								}}
								className={`px-1.5 py-0.5 rounded text-xs transition-colors ${
									(opt.ms === 0 && autoRefresh.paused) ||
									(opt.ms > 0 && autoRefresh.interval === opt.ms && !autoRefresh.paused)
										? "bg-surface-3 text-white"
										: "text-muted hover:text-white"
								}`}
							>
								{opt.label}
							</button>
						))}
					</div>
					<button
						onClick={refresh}
						className="text-muted hover:text-white transition-colors p-1"
						title="Refresh now"
					>
						<RefreshCw size={14} />
					</button>
				</div>
			</div>

			<SectionHeader>Claim Latency</SectionHeader>
			<ClaimLatencySection metrics={metrics} />

			<SectionHeader>Tenant Usage</SectionHeader>
			<TenantUsageSection metrics={metrics} />

			<SectionHeader>Cold Starts</SectionHeader>
			<ColdStartsSection metrics={metrics} />

			<SectionHeader>Tenant Data</SectionHeader>
			<TenantDataSection metrics={metrics} />

			<SectionHeader>Trigger Queues</SectionHeader>
			<TriggerQueuesSection metrics={metrics} />

			<SectionHeader>Node Resources</SectionHeader>
			<NodeResourcesSection metrics={metrics} />

			<details
				className="mt-8"
				open={rawOpen}
				onToggle={(e) => {
					const open = (e.target as HTMLDetailsElement).open;
					setRawOpen(open);
					if (open && !rawText) {
						fetch("/metrics")
							.then((r) => r.text())
							.then(setRawText)
							.catch(() => setRawText("Failed to fetch raw metrics"));
					}
				}}
			>
				<summary className="cursor-pointer text-sm font-mono text-muted hover:text-white transition-colors">
					Raw Metrics
				</summary>
				<pre className="mt-2 bg-surface-2 rounded-md p-4 text-xs font-mono text-muted-light overflow-x-auto max-h-96 overflow-y-auto select-all">
					{rawText ?? "loading..."}
				</pre>
			</details>
		</div>
	);
}
