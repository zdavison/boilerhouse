import { useState, useEffect, useRef } from "react";
import { useApi, useWebSocket } from "../hooks";
import { api, type ClaimResult, type BootstrapLogEntry } from "../api";
import { LoadingState, ErrorState, PageHeader, InfoCard, BackLink, ActionButton, StatusIndicator } from "../components";
import { JsonSyntax } from "../json-syntax";

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

	const [bootstrapLogs, setBootstrapLogs] = useState<BootstrapLogEntry[]>([]);
	const [logCopied, setLogCopied] = useState(false);
	const logContainerRef = useRef<HTMLDivElement>(null);

	// Fetch logs for any workload that has been through the bootstrap pipeline
	useEffect(() => {
		if (!data) return;
		api.fetchBootstrapLogs(name).then(setBootstrapLogs).catch(() => {});
	}, [data?.status, name]);

	// Listen for bootstrap.log WS events for this workload
	useWebSocket((event: unknown) => {
		const e = event as { type?: string; workloadId?: string; line?: string; timestamp?: string };
		if (
			e.type === "bootstrap.log" &&
			data &&
			e.workloadId === data.workloadId &&
			e.line !== undefined &&
			e.timestamp !== undefined
		) {
			setBootstrapLogs((prev) => [...prev, { text: e.line!, timestamp: e.timestamp! }]);
		}
	});

	// Auto-scroll log panel
	useEffect(() => {
		if (logContainerRef.current) {
			logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
		}
	}, [bootstrapLogs]);

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

			{/* Build log panel */}
			{(data.status === "creating" || bootstrapLogs.length > 0) && (
				<div className="mb-6">
					<h3 className="text-sm font-tight uppercase tracking-wider text-muted mb-3">
						Bootstrap Log
					</h3>
					<div className="bg-surface-2 rounded-md relative">
						{bootstrapLogs.length > 0 && (
							<button
								onClick={() => {
									const text = bootstrapLogs
										.map((e) => `${new Date(e.timestamp).toISOString()} ${e.text}`)
										.join("\n");
									navigator.clipboard.writeText(text).then(() => {
										setLogCopied(true);
										setTimeout(() => setLogCopied(false), 2000);
									});
								}}
								className="absolute top-2 right-5 flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-mono rounded-md border border-border bg-surface-3 text-muted hover:text-foreground hover:border-muted transition-colors"
							>
								<svg
									xmlns="http://www.w3.org/2000/svg"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
									className="w-3.5 h-3.5"
								>
									{logCopied ? (
										<path d="M20 6 9 17l-5-5" />
									) : (
										<>
											<rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
											<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
										</>
									)}
								</svg>
								{logCopied ? "copied" : "copy"}
							</button>
						)}
						<div
							ref={logContainerRef}
							className="p-4 max-h-80 overflow-y-auto"
						>
							{bootstrapLogs.length === 0 ? (
								<p className="text-xs font-mono text-muted">Waiting for bootstrap output...</p>
							) : (
								bootstrapLogs.map((entry, i) => {
									const isError = entry.text.startsWith("ERROR:");
									return (
										<div key={i} className="flex gap-2 text-xs font-mono leading-5">
											<span className="text-muted shrink-0">
												{new Date(entry.timestamp).toLocaleTimeString()}
											</span>
											<span className={isError ? "text-status-red" : "text-muted-light"}>
												{entry.text}
											</span>
										</div>
									);
								})
							)}
						</div>
					</div>
				</div>
			)}

			{/* Claim section */}
			<div className="mb-6">
				<h3 className="text-sm font-tight uppercase tracking-wider text-muted mb-3">
					Claim for Tenant
				</h3>
				{!isReady && (
					<p className="text-sm text-status-yellow mb-2">
						Workload is not ready — claims are disabled until the pool has warmed its first instance.
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
					<JsonSyntax data={data.config} />
				</div>
			)}
		</div>
	);
}
