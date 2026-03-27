import { useState, useEffect, useRef } from "react";
import { useApi } from "../hooks";
import { api, type ActivityLogEntry } from "../api";
import { LoadingState, ErrorState, PageHeader, InfoCard, BackLink, StatusIndicator, ActionButton } from "../components";

function relativeTime(iso: string): string {
	const diff = Date.now() - new Date(iso).getTime();
	if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
	if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
	if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
	return `${Math.round(diff / 86_400_000)}d ago`;
}

export function InstanceDetail({
	instanceId,
	navigate,
}: {
	instanceId: string;
	navigate: (path: string) => void;
}) {
	const { data, loading, error } = useApi(() => api.fetchInstance(instanceId));
	const [activity, setActivity] = useState<ActivityLogEntry[]>([]);
	const [logs, setLogs] = useState<string | null>(null);
	const [logsError, setLogsError] = useState<string | null>(null);
	const [logsLoading, setLogsLoading] = useState(false);
	const [autoRefresh, setAutoRefresh] = useState(true);
	const logContainerRef = useRef<HTMLDivElement>(null);

	// Fetch activity log for this instance
	useEffect(() => {
		if (!data) return;
		api.fetchActivity({ instanceId }).then(setActivity).catch(() => {});
	}, [data, instanceId]);

	// Fetch container logs
	const isLive = data && data.status !== "destroyed" && data.status !== "hibernated";

	function fetchLogs() {
		if (!isLive) return;
		setLogsLoading(true);
		api.fetchInstanceLogs(instanceId)
			.then((res) => {
				setLogs(res.logs);
				setLogsError(null);
			})
			.catch((err) => {
				setLogsError(err instanceof Error ? err.message : String(err));
			})
			.finally(() => setLogsLoading(false));
	}

	useEffect(() => {
		if (!isLive) return;
		fetchLogs();
	}, [isLive, instanceId]);

	// Auto-refresh logs every 3 seconds
	useEffect(() => {
		if (!isLive || !autoRefresh) return;
		const timer = setInterval(fetchLogs, 3000);
		return () => clearInterval(timer);
	}, [isLive, autoRefresh, instanceId]);

	// Auto-scroll log panel
	useEffect(() => {
		if (logContainerRef.current) {
			logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
		}
	}, [logs]);

	// Endpoint info
	const [endpoint, setEndpoint] = useState<{ host: string; ports: number[] } | null>(null);
	useEffect(() => {
		if (!isLive || data?.status === "starting") return;
		api.fetchInstanceEndpoint(instanceId)
			.then((res) => setEndpoint(res.endpoint))
			.catch(() => {});
	}, [isLive, instanceId, data?.status]);

	if (loading) return <LoadingState />;
	if (error) return <ErrorState message={error} />;
	if (!data) return null;

	return (
		<div>
			<BackLink label="workloads" onClick={() => navigate("/workloads")} />

			<PageHeader>Instance {instanceId.slice(0, 12)}</PageHeader>

			{/* Status + metadata */}
			<div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
				<div className="bg-surface-2 rounded-md p-4">
					<p className="text-xs font-tight uppercase tracking-wider text-muted mb-1">Status</p>
					<StatusIndicator status={data.status} />
				</div>
				<InfoCard label="Instance ID" value={data.instanceId} />
				<InfoCard label="Workload" value={data.workloadId} />
				<InfoCard label="Tenant" value={data.tenantId ?? "none"} />
				<InfoCard label="Node" value={data.nodeId} />
				<InfoCard label="Created" value={new Date(data.createdAt).toLocaleString()} />
				{data.claimedAt && (
					<InfoCard label="Claimed" value={new Date(data.claimedAt).toLocaleString()} />
				)}
				{data.lastActivity && (
					<InfoCard label="Last Activity" value={relativeTime(data.lastActivity)} />
				)}
			</div>

			{/* Endpoint */}
			{endpoint && (
				<div className="mb-6">
					<h3 className="text-sm font-tight uppercase tracking-wider text-muted mb-3">
						Endpoint
					</h3>
					<div className="bg-surface-2 rounded-md p-4">
						<p className="text-sm font-mono text-muted-light">
							{endpoint.host}:{endpoint.ports.join(", ")}
						</p>
					</div>
				</div>
			)}

			{/* Container Logs */}
			<div className="mb-6">
				<div className="flex items-center justify-between mb-3">
					<h3 className="text-sm font-tight uppercase tracking-wider text-muted">
						Container Logs
					</h3>
					<div className="flex items-center gap-2">
						{isLive && (
							<>
								<label className="flex items-center gap-1.5 text-xs text-muted">
									<input
										type="checkbox"
										checked={autoRefresh}
										onChange={(e) => setAutoRefresh(e.target.checked)}
										className="rounded"
									/>
									auto-refresh
								</label>
								<ActionButton
									label={logsLoading ? "loading..." : "refresh"}
									variant="default"
									disabled={logsLoading}
									onClick={fetchLogs}
								/>
							</>
						)}
					</div>
				</div>
				<div className="bg-surface-2 rounded-md">
					{!isLive ? (
						<p className="p-4 text-xs font-mono text-muted">
							Instance is {data.status} - no logs available.
						</p>
					) : logsError ? (
						<p className="p-4 text-xs font-mono text-status-red">{logsError}</p>
					) : logs === null ? (
						<p className="p-4 text-xs font-mono text-muted">Loading logs...</p>
					) : logs.length === 0 ? (
						<p className="p-4 text-xs font-mono text-muted">No output yet.</p>
					) : (
						<div
							ref={logContainerRef}
							className="p-4 max-h-96 overflow-y-auto"
						>
							{logs.split("\n").map((line, i) => (
								<div key={i} className="text-xs font-mono leading-5 text-muted-light whitespace-pre-wrap">
									{line}
								</div>
							))}
						</div>
					)}
				</div>
			</div>

			{/* Activity Log */}
			<div className="mb-6">
				<h3 className="text-sm font-tight uppercase tracking-wider text-muted mb-3">
					Activity
				</h3>
				{activity.length === 0 ? (
					<p className="text-sm text-muted">No activity recorded.</p>
				) : (
					<div className="bg-surface-2 rounded-md overflow-hidden">
						<table className="w-full text-xs font-mono">
							<thead>
								<tr className="border-b border-border">
									<th className="text-left px-3 py-2 text-muted">Time</th>
									<th className="text-left px-3 py-2 text-muted">Event</th>
									<th className="text-left px-3 py-2 text-muted">Details</th>
								</tr>
							</thead>
							<tbody>
								{activity.map((row) => (
									<tr key={row.id} className="border-b border-border/50">
										<td className="px-3 py-1.5 text-muted whitespace-nowrap">
											{relativeTime(row.createdAt)}
										</td>
										<td className="px-3 py-1.5">
											<span className={eventColor(row.event)}>
												{row.event}
											</span>
										</td>
										<td className="px-3 py-1.5 text-muted-light">
											{row.metadata ? JSON.stringify(row.metadata) : ""}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</div>

			{/* Actions */}
			{isLive && (
				<div className="flex gap-2">
					<ActionButton
						label="hibernate"
						variant="warning"
						onClick={async () => {
							await api.hibernateInstance(instanceId);
							navigate("/workloads");
						}}
					/>
					<ActionButton
						label="destroy"
						variant="danger"
						onClick={async () => {
							await api.destroyInstance(instanceId);
							navigate("/workloads");
						}}
					/>
				</div>
			)}
		</div>
	);
}

function eventColor(event: string): string {
	if (event.includes("error")) return "text-status-red";
	if (event.includes("created") || event.includes("claimed") || event.includes("ready")) return "text-status-green";
	if (event.includes("released") || event.includes("hibernated") || event.includes("destroyed")) return "text-status-yellow";
	if (event.includes("starting") || event.includes("restoring")) return "text-status-blue";
	return "text-muted-light";
}
