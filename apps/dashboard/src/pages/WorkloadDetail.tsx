import { useState } from "react";
import { useApi } from "../hooks";
import { api, type ClaimResult } from "../api";
import { LoadingState, ErrorState, PageHeader, InfoCard, BackLink, ActionButton, StatusIndicator } from "../components";

export function WorkloadDetail({
	name,
	navigate,
}: {
	name: string;
	navigate: (path: string) => void;
}) {
	const { data, loading, error } = useApi(() => api.fetchWorkload(name));

	const [tenantId, setTenantId] = useState("");
	const [claiming, setClaiming] = useState(false);
	const [claimResult, setClaimResult] = useState<ClaimResult | null>(null);
	const [claimError, setClaimError] = useState<string | null>(null);

	async function handleClaim() {
		if (!tenantId.trim() || !data) return;
		setClaiming(true);
		setClaimResult(null);
		setClaimError(null);
		try {
			const result = await api.claimWorkload(tenantId.trim(), data.name);
			setClaimResult(result);
		} catch (err) {
			setClaimError(err instanceof Error ? err.message : "Claim failed");
		} finally {
			setClaiming(false);
		}
	}

	if (loading) return <LoadingState />;
	if (error) return <ErrorState message={error} />;
	if (!data) return null;

	const isReady = data.status === "ready";

	return (
		<div>
			<BackLink label="workloads" onClick={() => navigate("/workloads")} />

			<PageHeader>{data.name}</PageHeader>

			<div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
				<InfoCard label="Workload ID" value={data.workloadId} />
				<InfoCard label="Version" value={data.version} />
				<div className="bg-surface-2 rounded-md p-4">
					<p className="text-xs font-tight uppercase tracking-wider text-muted mb-1">Status</p>
					<StatusIndicator status={data.status} />
				</div>
				<InfoCard label="Instances" value={String(data.instanceCount)} />
				<InfoCard label="Created" value={new Date(data.createdAt).toLocaleString()} />
				<InfoCard label="Updated" value={new Date(data.updatedAt).toLocaleString()} />
			</div>

			{/* Claim section */}
			<div className="mb-6">
				<h3 className="text-sm font-tight uppercase tracking-wider text-muted mb-3">
					Claim for Tenant
				</h3>
				{!isReady && (
					<p className="text-sm text-status-yellow mb-2">
						Workload is not ready — claims are disabled until the golden snapshot is created.
					</p>
				)}
				<div className="flex items-center gap-2">
					<input
						type="text"
						placeholder="tenant-id"
						value={tenantId}
						disabled={!isReady}
						onChange={(e) => setTenantId(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") handleClaim();
						}}
						className="bg-surface-2 border border-border rounded-md px-3 py-1 text-sm font-mono text-foreground placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-status-blue disabled:opacity-50"
					/>
					<ActionButton
						label={claiming ? "claiming…" : "claim"}
						variant="info"
						disabled={!isReady || claiming || !tenantId.trim()}
						onClick={handleClaim}
					/>
				</div>

				{claimError && (
					<p className="mt-2 text-sm text-status-red">{claimError}</p>
				)}

				{claimResult && (
					<div className="mt-2 text-sm text-muted-light space-y-1">
						<p>
							Instance:{" "}
							<a
								href={`#/instances/${claimResult.instanceId}`}
								className="text-status-blue hover:underline font-mono"
							>
								{claimResult.instanceId}
							</a>
						</p>
						<p>Source: {claimResult.source}</p>
						<p>Latency: {claimResult.latencyMs}ms</p>
					</div>
				)}
			</div>

			{data.config != null && (
				<div>
					<h3 className="text-sm font-tight uppercase tracking-wider text-muted mb-3">
						Configuration
					</h3>
					<pre className="bg-surface-2 rounded-md p-4 text-sm font-mono text-muted-light overflow-x-auto">
						{JSON.stringify(data.config, null, 2)}
					</pre>
				</div>
			)}
		</div>
	);
}
