import { useApi } from "../hooks";
import { api, type SnapshotSummary } from "../api";
import { LoadingState, ErrorState, PageHeader, StatusIndicator, DataTable, DataRow } from "../components";

function formatBytes(bytes: number): string {
	if (bytes === 0) return "0 B";
	const units = ["B", "KB", "MB", "GB"];
	const i = Math.floor(Math.log(bytes) / Math.log(1024));
	return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

export function SnapshotList() {
	const { data, loading, error } = useApi<SnapshotSummary[]>(api.fetchSnapshots);

	if (loading) return <LoadingState />;
	if (error) return <ErrorState message={error} />;
	if (!data) return null;

	return (
		<div>
			<PageHeader>snapshots</PageHeader>
			{data.length === 0 ? (
				<p className="text-muted font-mono text-sm">no snapshots found.</p>
			) : (
				<DataTable headers={["Snapshot ID", "Type", "Workload", "Instance ID", "Tenant ID", "Node ID", "Size", "Status", "Created"]}>
					{data.map((s) => (
						<DataRow key={s.snapshotId}>
							<td className="px-4 py-3 text-gray-200">{s.snapshotId}</td>
							<td className="px-4 py-3 text-muted-light">{s.type}</td>
							<td className="px-4 py-3 text-muted-light">{s.workloadName ?? s.workloadId}</td>
							<td className="px-4 py-3 text-muted-light">{s.instanceId}</td>
							<td className="px-4 py-3 text-muted">{s.tenantId ?? "—"}</td>
							<td className="px-4 py-3 text-muted">{s.nodeId}</td>
							<td className="px-4 py-3 text-muted-light">{formatBytes(s.sizeBytes)}</td>
							<td className="px-4 py-3">
								<StatusIndicator status={s.status} detail={s.statusDetail ?? undefined} />
							</td>
							<td className="px-4 py-3 text-muted">
								{new Date(s.createdAt).toLocaleString()}
							</td>
						</DataRow>
					))}
				</DataTable>
			)}
		</div>
	);
}
