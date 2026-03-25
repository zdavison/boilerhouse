import { useState, useCallback } from "react";
import { RefreshCw } from "lucide-react";
import { useApi, useAutoRefresh } from "../hooks";
import {
	fetchMetrics,
	getGaugeValues,
	getCounterValues,
	computePercentile,
	getHistogramAvg,
	type PrometheusMetrics,
	type PrometheusSample,
} from "../prometheus";
import {
	PageHeader,
	DataTable,
	DataRow,
	LoadingState,
	ErrorState,
} from "../components";

const REFRESH_OPTIONS = [
	{ label: "5s", ms: 5000 },
	{ label: "10s", ms: 10000 },
	{ label: "30s", ms: 30000 },
	{ label: "60s", ms: 60000 },
	{ label: "off", ms: 0 },
];

function formatDuration(seconds: number): string {
	if (seconds < 0.001) return "<1ms";
	if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
	return `${seconds.toFixed(1)}s`;
}

function formatBytes(bytes: number): string {
	if (bytes === 0) return "0 B";
	const units = ["B", "KB", "MB", "GB", "TB"];
	const i = Math.floor(Math.log(bytes) / Math.log(1024));
	const val = bytes / Math.pow(1024, i);
	return `${val.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function sumValues(samples: PrometheusSample[]): number {
	return samples.reduce((acc, s) => acc + s.value, 0);
}

function MetricStatCard({ label, value, subtext }: { label: string; value: string; subtext?: string }) {
	return (
		<div className="bg-surface-2 rounded-md p-5">
			<p className="text-sm text-muted-light">{label}</p>
			<p className="text-3xl font-bold font-mono mt-1">{value}</p>
			{subtext && <p className="text-xs text-muted mt-1">{subtext}</p>}
		</div>
	);
}

function SectionHeader({ children }: { children: React.ReactNode }) {
	return (
		<h3 className="text-base font-tight font-semibold mt-8 mb-3 text-muted-light">
			{children}
		</h3>
	);
}

function NoData() {
	return (
		<div className="text-center py-4 text-muted text-sm font-mono">
			no data yet
		</div>
	);
}

// ── Overview Section ────────────────────────────────────────────────────────

function OverviewSection({ metrics }: { metrics: PrometheusMetrics }) {
	const activeTenants = sumValues(getGaugeValues(metrics, "boilerhouse_tenants_active"));
	const activeInstances = sumValues(
		getGaugeValues(metrics, "boilerhouse_instances").filter((s) => s.labels.status === "active"),
	);
	const capacityMax = sumValues(getGaugeValues(metrics, "boilerhouse_node_capacity_max"));
	const capacityUsed = sumValues(getGaugeValues(metrics, "boilerhouse_node_capacity_used"));
	const claimP50 = computePercentile(metrics, "boilerhouse_tenant_claim_duration_seconds", 0.5);
	const claimP95 = computePercentile(metrics, "boilerhouse_tenant_claim_duration_seconds", 0.95);
	const poolDepth = sumValues(getGaugeValues(metrics, "boilerhouse_pool_depth"));
	const coldStartAvg = getHistogramAvg(metrics, "boilerhouse_pool_cold_start_duration_seconds");

	return (
		<div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-3">
			<MetricStatCard label="Active Tenants" value={String(activeTenants)} />
			<MetricStatCard label="Active Instances" value={String(activeInstances)} />
			<MetricStatCard
				label="Capacity"
				value={capacityMax > 0 ? `${Math.round((capacityUsed / capacityMax) * 100)}%` : "--"}
				subtext={`${capacityUsed} / ${capacityMax}`}
			/>
			<MetricStatCard
				label="Claim p50"
				value={claimP50 !== null ? formatDuration(claimP50) : "--"}
			/>
			<MetricStatCard
				label="Claim p95"
				value={claimP95 !== null ? formatDuration(claimP95) : "--"}
			/>
			<MetricStatCard label="Pool Depth" value={String(poolDepth)} />
			<MetricStatCard
				label="Cold Start avg"
				value={coldStartAvg !== null ? formatDuration(coldStartAvg) : "--"}
			/>
		</div>
	);
}

// ── Pool Section ─────────────────────────────────────────────────────────────

function PoolSection({ metrics }: { metrics: PrometheusMetrics }) {
	const depthGauges = getGaugeValues(metrics, "boilerhouse_pool_depth");
	if (depthGauges.length === 0) return <NoData />;

	return (
		<DataTable headers={["Workload", "Pool Depth", "Cold Start avg"]}>
			{depthGauges.map((s) => {
				const workload = s.labels.workload ?? "";
				const avg = getHistogramAvg(metrics, "boilerhouse_pool_cold_start_duration_seconds", { workload });
				return (
					<DataRow key={workload}>
						<td className="px-4 py-2 text-accent">{workload || "(none)"}</td>
						<td className="px-4 py-2">{s.value}</td>
						<td className="px-4 py-2">{avg !== null ? formatDuration(avg) : "--"}</td>
					</DataRow>
				);
			})}
		</DataTable>
	);
}

// ── Tenants Section ─────────────────────────────────────────────────────────

function TenantsSection({ metrics }: { metrics: PrometheusMetrics }) {
	const activeGauges = getGaugeValues(metrics, "boilerhouse_tenants_active");
	const claims = getCounterValues(metrics, "boilerhouse_tenant_claims");
	const releases = getCounterValues(metrics, "boilerhouse_tenant_releases");

	if (activeGauges.length === 0 && claims.length === 0) return <NoData />;

	const workloads = new Set<string>();
	for (const s of activeGauges) workloads.add(s.labels.workload ?? "");
	for (const s of claims) workloads.add(s.labels.workload ?? "");
	for (const s of releases) workloads.add(s.labels.workload ?? "");

	return (
		<DataTable headers={["Workload", "Active", "Claims (total)", "Releases (total)", "p50", "p95"]}>
			{[...workloads].map((w) => {
				const active = activeGauges.find((s) => s.labels.workload === w)?.value ?? 0;
				const totalClaims = sumValues(claims.filter((s) => s.labels.workload === w));
				const totalReleases = sumValues(releases.filter((s) => s.labels.workload === w));
				const p50 = computePercentile(
					metrics, "boilerhouse_tenant_claim_duration_seconds", 0.5, { workload: w },
				);
				const p95 = computePercentile(
					metrics, "boilerhouse_tenant_claim_duration_seconds", 0.95, { workload: w },
				);
				return (
					<DataRow key={w}>
						<td className="px-4 py-2 text-accent">{w || "(none)"}</td>
						<td className="px-4 py-2">{active}</td>
						<td className="px-4 py-2">{totalClaims}</td>
						<td className="px-4 py-2">{totalReleases}</td>
						<td className="px-4 py-2">{p50 !== null ? formatDuration(p50) : "--"}</td>
						<td className="px-4 py-2">{p95 !== null ? formatDuration(p95) : "--"}</td>
					</DataRow>
				);
			})}
		</DataTable>
	);
}

// ── Instances Section ───────────────────────────────────────────────────────

function InstancesSection({ metrics }: { metrics: PrometheusMetrics }) {
	const gauges = getGaugeValues(metrics, "boilerhouse_instances");
	if (gauges.length === 0) return <NoData />;

	// Group by workload + node
	type Key = string;
	const rows = new Map<Key, Record<string, number>>();
	const keys = new Map<Key, { workload: string; node: string }>();

	for (const s of gauges) {
		const workload = s.labels.workload ?? "";
		const node = s.labels.node ?? "";
		const key: Key = `${workload}|${node}`;
		if (!keys.has(key)) keys.set(key, { workload, node });
		const row = rows.get(key) ?? {};
		row[s.labels.status ?? ""] = s.value;
		rows.set(key, row);
	}

	return (
		<DataTable headers={["Workload", "Node", "Starting", "Active", "Destroyed"]}>
			{[...keys.entries()].map(([key, { workload, node }]) => {
				const r = rows.get(key)!;
				return (
					<DataRow key={key}>
						<td className="px-4 py-2 text-accent">{workload || "(none)"}</td>
						<td className="px-4 py-2 text-muted">{truncateId(node)}</td>
						<td className="px-4 py-2">{r.starting ?? 0}</td>
						<td className="px-4 py-2">{r.active ?? 0}</td>
						<td className="px-4 py-2">{r.destroyed ?? 0}</td>
					</DataRow>
				);
			})}
		</DataTable>
	);
}

// ── Capacity Section ────────────────────────────────────────────────────────

function CapacitySection({ metrics }: { metrics: PrometheusMetrics }) {
	const maxGauges = getGaugeValues(metrics, "boilerhouse_node_capacity_max");
	const usedGauges = getGaugeValues(metrics, "boilerhouse_node_capacity_used");
	const queueGauges = getGaugeValues(metrics, "boilerhouse_capacity_queue_depth");

	if (maxGauges.length === 0) return <NoData />;

	const nodes = new Set<string>();
	for (const s of maxGauges) nodes.add(s.labels.node ?? "");

	return (
		<DataTable headers={["Node", "Max", "Used", "Utilisation %", "Queue Depth"]}>
			{[...nodes].map((n) => {
				const max = maxGauges.find((s) => s.labels.node === n)?.value ?? 0;
				const used = usedGauges.find((s) => s.labels.node === n)?.value ?? 0;
				const queue = queueGauges.find((s) => s.labels.node === n)?.value ?? 0;
				const pct = max > 0 ? Math.round((used / max) * 100) : 0;
				return (
					<DataRow key={n}>
						<td className="px-4 py-2 text-muted">{truncateId(n)}</td>
						<td className="px-4 py-2">{max}</td>
						<td className="px-4 py-2">{used}</td>
						<td className="px-4 py-2">{pct}%</td>
						<td className="px-4 py-2">{queue}</td>
					</DataRow>
				);
			})}
		</DataTable>
	);
}

// ── Instance Transitions Section ─────────────────────────────────────────────

function InstanceTransitionsSection({ metrics }: { metrics: PrometheusMetrics }) {
	const METRIC = "boilerhouse_instance_transition_duration_seconds";
	const buckets = metrics.byName.get(METRIC)?.samples.filter((s) => s.name === `${METRIC}_bucket`) ?? [];
	if (buckets.length === 0) return <NoData />;

	const combos = new Map<string, { from: string; workload: string }>();
	for (const s of buckets) {
		const from = s.labels.from ?? "";
		const workload = s.labels.workload ?? "";
		const key = `${from}|${workload}`;
		if (!combos.has(key)) combos.set(key, { from, workload });
	}

	return (
		<DataTable headers={["State", "Workload", "p50", "p95"]}>
			{[...combos.values()].map(({ from, workload }) => {
				const p50 = computePercentile(metrics, METRIC, 0.5, { from, workload });
				const p95 = computePercentile(metrics, METRIC, 0.95, { from, workload });
				return (
					<DataRow key={`${from}|${workload}`}>
						<td className="px-4 py-2 text-muted-light">{from}</td>
						<td className="px-4 py-2 text-accent">{workload || "(none)"}</td>
						<td className="px-4 py-2">{p50 !== null ? formatDuration(p50) : "--"}</td>
						<td className="px-4 py-2">{p95 !== null ? formatDuration(p95) : "--"}</td>
					</DataRow>
				);
			})}
		</DataTable>
	);
}

// ── HTTP Section ────────────────────────────────────────────────────────────

function HttpSection({ metrics }: { metrics: PrometheusMetrics }) {
	const requests = getCounterValues(metrics, "http_server_request");
	if (requests.length === 0) return <NoData />;

	// Group by route + method
	type Key = string;
	const rows = new Map<Key, { method: string; route: string; total: number; errors: number }>();

	for (const s of requests) {
		const method = s.labels.http_request_method ?? "";
		const route = s.labels.http_route ?? "";
		const key: Key = `${method} ${route}`;
		const existing = rows.get(key) ?? { method, route, total: 0, errors: 0 };
		existing.total += s.value;
		const status = Number(s.labels.http_response_status_code ?? 0);
		if (status >= 500) existing.errors += s.value;
		rows.set(key, existing);
	}

	return (
		<DataTable headers={["Route", "Method", "Requests (total)", "Errors 5xx (total)", "p50", "p95"]}>
			{[...rows.entries()].map(([key, { method, route, total, errors }]) => {
				const p50 = computePercentile(
					metrics, "http_server_request_duration_seconds", 0.5,
					{ http_request_method: method, http_route: route },
				);
				const p95 = computePercentile(
					metrics, "http_server_request_duration_seconds", 0.95,
					{ http_request_method: method, http_route: route },
				);
				return (
					<DataRow key={key}>
						<td className="px-4 py-2 text-accent">{route}</td>
						<td className="px-4 py-2">{method}</td>
						<td className="px-4 py-2">{total}</td>
						<td className="px-4 py-2">{errors > 0 ? <span className="text-status-red">{errors}</span> : 0}</td>
						<td className="px-4 py-2">{p50 !== null ? formatDuration(p50) : "--"}</td>
						<td className="px-4 py-2">{p95 !== null ? formatDuration(p95) : "--"}</td>
					</DataRow>
				);
			})}
		</DataTable>
	);
}

// ── Main Page ───────────────────────────────────────────────────────────────

function truncateId(id: string): string {
	if (id.length <= 12) return id;
	return id.slice(0, 8) + "...";
}

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

			<OverviewSection metrics={metrics} />

			<SectionHeader>Pool</SectionHeader>
			<PoolSection metrics={metrics} />

			<SectionHeader>Tenants</SectionHeader>
			<TenantsSection metrics={metrics} />

			<SectionHeader>Instances</SectionHeader>
			<InstancesSection metrics={metrics} />

			<SectionHeader>Instance Transition Times</SectionHeader>
			<InstanceTransitionsSection metrics={metrics} />

			<SectionHeader>Capacity</SectionHeader>
			<CapacitySection metrics={metrics} />

			<SectionHeader>HTTP</SectionHeader>
			<HttpSection metrics={metrics} />

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
