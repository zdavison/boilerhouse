import { useState } from "react";
import { useApi } from "../hooks";
import { api, type WorkloadSummary, type ClaimResult } from "../api";
import { LoadingState, ErrorState, PageHeader, DataTable, DataRow, ActionButton, StatusIndicator } from "../components";

function ClaimCell({ workloadName, disabled }: { workloadName: string; disabled?: boolean }) {
	const [expanded, setExpanded] = useState(false);
	const [tenantId, setTenantId] = useState("");
	const [claiming, setClaiming] = useState(false);
	const [result, setResult] = useState<ClaimResult | null>(null);
	const [error, setError] = useState<string | null>(null);

	async function handleClaim() {
		if (!tenantId.trim()) return;
		setClaiming(true);
		setResult(null);
		setError(null);
		try {
			const res = await api.claimWorkload(tenantId.trim(), workloadName);
			setResult(res);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Claim failed");
		} finally {
			setClaiming(false);
		}
	}

	if (!expanded) {
		return (
			<ActionButton
				label="claim"
				variant="info"
				disabled={disabled}
				onClick={() => setExpanded(true)}
			/>
		);
	}

	return (
		<div className="flex flex-col gap-1">
			<div className="flex items-center gap-1">
				<input
					type="text"
					placeholder="tenant-id"
					value={tenantId}
					autoFocus
					onChange={(e) => setTenantId(e.target.value)}
					onKeyDown={(e) => {
						if (e.key === "Enter") handleClaim();
						if (e.key === "Escape") setExpanded(false);
					}}
					className="bg-surface-3 border border-border rounded px-2 py-0.5 text-xs font-mono text-foreground placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-status-blue w-28"
				/>
				<ActionButton
					label={claiming ? "…" : "go"}
					variant="info"
					disabled={claiming || !tenantId.trim()}
					onClick={handleClaim}
				/>
			</div>
			{error && (
				<span className="text-xs text-status-red truncate max-w-[200px]" title={error}>
					{error}
				</span>
			)}
			{result && (
				<a
					href={`#/instances/${result.instanceId}`}
					className="text-xs text-accent hover:text-accent-bright truncate"
				>
					{result.source} → {result.instanceId.slice(0, 12)}…
				</a>
			)}
		</div>
	);
}

export function WorkloadList({ navigate }: { navigate: (path: string) => void }) {
	const { data, loading, error } = useApi<WorkloadSummary[]>(api.fetchWorkloads);

	if (loading) return <LoadingState />;
	if (error) return <ErrorState message={error} />;
	if (!data) return null;

	return (
		<div>
			<PageHeader>workloads</PageHeader>
			{data.length === 0 ? (
				<p className="text-muted font-mono text-sm">no workloads registered.</p>
			) : (
				<DataTable headers={["Name", "Version", "Status", "Created", "Updated", "Actions"]}>
					{data.map((w) => (
						<DataRow key={w.workloadId} onClick={() => navigate(`/workloads/${w.name}`)}>
							<td className="px-4 py-3 text-accent hover:text-accent-bright">
								{w.name}
							</td>
							<td className="px-4 py-3 text-muted-light">{w.version}</td>
							<td className="px-4 py-3">
								<StatusIndicator status={w.status} />
							</td>
							<td className="px-4 py-3 text-muted">
								{new Date(w.createdAt).toLocaleString()}
							</td>
							<td className="px-4 py-3 text-muted">
								{new Date(w.updatedAt).toLocaleString()}
							</td>
							<td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
								<ClaimCell workloadName={w.name} disabled={w.status !== "ready"} />
							</td>
						</DataRow>
					))}
				</DataTable>
			)}
		</div>
	);
}
