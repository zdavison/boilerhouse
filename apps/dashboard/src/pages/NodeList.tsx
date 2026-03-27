import { useApi } from "../hooks";
import { api, type NodeSummary } from "../api";
import { LoadingState, ErrorState, PageHeader, StatusIndicator, DataTable, DataRow } from "../components";

export function NodeList() {
	const { data, loading, error } = useApi<NodeSummary[]>(api.fetchNodes);

	if (loading) return <LoadingState />;
	if (error) return <ErrorState message={error} />;
	if (!data) return null;

	return (
		<div>
			<PageHeader>nodes</PageHeader>
			{data.length === 0 ? (
				<p className="text-muted font-mono text-sm">no nodes registered.</p>
			) : (
				<DataTable headers={["Node ID", "Runtime", "Status", "vCPUs", "Memory", "Disk", "Last Heartbeat", "Created"]}>
					{data.map((n) => (
						<DataRow key={n.nodeId}>
							<td className="px-4 py-3 text-gray-200">
								{n.nodeId}
							</td>
							<td className="px-4 py-3 text-muted-light">{n.runtimeType}</td>
							<td className="px-4 py-3">
								<StatusIndicator status={n.status} detail={n.statusDetail ?? undefined} />
							</td>
							<td className="px-4 py-3 text-muted-light">{n.capacity.vcpus}</td>
							<td className="px-4 py-3 text-muted-light">
								{n.capacity.memoryMb} MB
							</td>
							<td className="px-4 py-3 text-muted-light">
								{n.capacity.diskGb} GB
							</td>
							<td className="px-4 py-3 text-muted">
								{new Date(n.lastHeartbeat).toLocaleString()}
							</td>
							<td className="px-4 py-3 text-muted">
								{new Date(n.createdAt).toLocaleString()}
							</td>
						</DataRow>
					))}
				</DataTable>
			)}
		</div>
	);
}
