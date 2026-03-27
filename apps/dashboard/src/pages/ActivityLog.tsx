import { useMemo } from "react";
import { useApi } from "../hooks";
import { api, type ActivityLogEntry } from "../api";
import { LoadingState, ErrorState, PageHeader } from "../components";

/** Formats an ISO date string as a short relative time (e.g. "2m ago", "3h ago"). */
function relativeTime(iso: string): string {
	const diffMs = Date.now() - new Date(iso).getTime();
	const seconds = Math.floor(diffMs / 1000);
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	const days = Math.floor(hours / 24);
	return `${days}d ago`;
}

/** Truncates an ID to 8 characters for compact display. */
function shortId(id: string): string {
	return id.length > 12 ? id.slice(0, 8) + "\u2026" : id;
}

/**
 * Maps event names to colors:
 * - green: created, claimed
 * - yellow: released
 * - red: destroyed, error
 * - blue: other instance/trigger events
 */
function eventColor(entry: ActivityLogEntry): string {
	const e = entry.event;
	if (e.includes("error")) return "text-status-red";
	if (e.includes("destroyed")) return "text-status-red";
	if (e.includes("created") || e.includes("claimed") || e.includes("dispatched") || e.includes("ready") || e === "workload.registered") return "text-status-green";
	if (e.includes("released") || e.includes("hibernated") || e.includes("timeout")) return "text-status-yellow";
	if (e.includes("starting") || e.includes("invoked") || e.includes("acquired") || e.includes("replenish")) return "text-status-blue";
	return "text-gray-200";
}

/**
 * Returns a Tailwind color class for a metadata value based on key and value.
 * Highlights claim source values: green for pool hits, blue for cold boots.
 */
function metadataValueColor(key: string, value: string): string {
	if (key === "source") {
		if (value === "pool" || value === "pool+data") return "text-status-green";
		if (value === "cold" || value === "cold+data") return "text-status-blue";
		if (value === "existing") return "text-status-yellow";
	}
	return "text-muted-light";
}

/** Renders key=value metadata pairs inline. */
function MetadataInline({ metadata }: { metadata: Record<string, unknown> }) {
	const entries = Object.entries(metadata);
	if (entries.length === 0) return null;

	return (
		<span className="text-muted">
			{entries.map(([k, v], i) => (
				<span key={k}>
					{i > 0 && " "}
					<span className="text-muted">{k}</span>
					<span className="text-muted">=</span>
					<span className={metadataValueColor(k, String(v))}>{String(v)}</span>
				</span>
			))}
		</span>
	);
}

const HEADERS = ["Time", "Event", "Workload", "Instance", "Tenant", "Node", "Details"];

export function ActivityLog() {
	const { data, loading, error } = useApi(() => api.fetchActivity());
	const { data: workloads } = useApi(api.fetchWorkloads);

	const workloadNames = useMemo(() => {
		const map = new Map<string, string>();
		if (workloads) {
			for (const w of workloads) map.set(w.workloadId, w.name);
		}
		return map;
	}, [workloads]);

	if (loading) return <LoadingState />;
	if (error) return <ErrorState message={error} />;
	if (!data) return null;

	return (
		<div>
			<PageHeader>audit</PageHeader>
			{data.length === 0 ? (
				<p className="text-muted font-mono text-sm">no activity logged yet.</p>
			) : (
				<div className="overflow-x-auto">
					<table className="w-full text-xs text-left font-mono">
						<thead className="text-xs font-tight uppercase tracking-wider text-muted border-b border-border/30">
							<tr>
								{HEADERS.map((h) => (
									<th key={h} className="px-2 py-1.5">{h}</th>
								))}
							</tr>
						</thead>
						<tbody>
							{data.map((entry) => {
								const color = eventColor(entry);
								return (
									<tr
										key={entry.id}
										className="h-7 border-b border-border/10 hover:bg-surface-3/30 transition-colors"
									>
										<td
											className="px-2 text-muted whitespace-nowrap"
											title={new Date(entry.createdAt).toLocaleString()}
										>
											{relativeTime(entry.createdAt)}
										</td>
										<td className={`px-2 whitespace-nowrap ${color}`}>
											{entry.event}
										</td>
										<td className="px-2 text-muted-light" title={entry.workloadId ?? undefined}>
											{entry.workloadId
											? (workloadNames.get(entry.workloadId) ?? shortId(entry.workloadId))
											: "\u2014"}
										</td>
										<td className="px-2 text-muted-light" title={entry.instanceId ?? undefined}>
											{entry.instanceId ? (
											<a href={`#/instances/${entry.instanceId}`} className="hover:text-status-blue hover:underline">
												{shortId(entry.instanceId)}
											</a>
										) : "\u2014"}
										</td>
										<td className="px-2 text-muted-light" title={entry.tenantId ?? undefined}>
											{entry.tenantId ?? "\u2014"}
										</td>
										<td className="px-2 text-muted-light" title={entry.nodeId ?? undefined}>
											{entry.nodeId ? shortId(entry.nodeId) : "\u2014"}
										</td>
										<td className="px-2">
											{entry.metadata && <MetadataInline metadata={entry.metadata} />}
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				</div>
			)}
		</div>
	);
}
