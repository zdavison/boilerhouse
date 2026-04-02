import { useState, useCallback, useEffect } from "react";
import { ChevronDown, ChevronRight, Plug, Trash2, UserPlus, Loader2, Moon } from "lucide-react";
import { useApi, useWebSocket } from "../hooks";
import {
	api,
	type WorkloadSummary,
	type InstanceSummary,
	type ClaimResult,
} from "../api";
import {
	LoadingState,
	ErrorState,
	PageHeader,
	StatusIndicator,
	ConnectionModal,
} from "../components";

// --- Tree types ---

interface InstanceNode {
	instance: InstanceSummary;
}

interface WorkloadTreeNode {
	workload: WorkloadSummary;
	/** Unclaimed pool instances (tenantId === null). */
	poolInstances: InstanceNode[];
	/** Instances claimed by a tenant (tenantId !== null). */
	claimedInstances: InstanceNode[];
}

// --- Tree builder ---

function buildWorkloadTree(
	workloads: WorkloadSummary[],
	instances: InstanceSummary[],
): WorkloadTreeNode[] {
	const instancesByWorkload = new Map<string, InstanceSummary[]>();
	for (const inst of instances) {
		if (inst.status === "destroyed") continue;
		const list = instancesByWorkload.get(inst.workloadId) ?? [];
		list.push(inst);
		instancesByWorkload.set(inst.workloadId, list);
	}

	return workloads.map((workload) => {
		const all = instancesByWorkload.get(workload.workloadId) ?? [];
		return {
			workload,
			poolInstances: all.filter((i) => i.tenantId === null).map((inst) => ({ instance: inst })),
			claimedInstances: all.filter((i) => i.tenantId !== null).map((inst) => ({ instance: inst })),
		};
	});
}

// --- Formatting ---

function formatDate(dateStr: string): string {
	return new Date(dateStr).toLocaleDateString();
}

function shortId(id: string): string {
	return id.slice(0, 8);
}

// --- Icon Action Button ---

const ICON_VARIANTS: Record<string, string> = {
	danger: "text-status-red bg-status-red/10 border-status-red/20 hover:bg-status-red/20 active:bg-status-red/30",
	warning: "text-status-yellow bg-status-yellow/10 border-status-yellow/20 hover:bg-status-yellow/20 active:bg-status-yellow/30",
	info: "text-status-blue bg-status-blue/10 border-status-blue/20 hover:bg-status-blue/20 active:bg-status-blue/30",
};

function IconButton({
	icon: Icon,
	title,
	variant,
	onClick,
	disabled,
}: {
	icon: typeof Plug;
	title: string;
	variant: "danger" | "warning" | "info";
	onClick: () => void;
	/** @default false */
	disabled?: boolean;
}) {
	return (
		<button
			title={title}
			disabled={disabled}
			onClick={(e) => {
				e.stopPropagation();
				onClick();
			}}
			className={`p-1 rounded border shadow-sm transition-colors ${ICON_VARIANTS[variant]} disabled:opacity-30 disabled:pointer-events-none disabled:shadow-none`}
		>
			<Icon size={13} />
		</button>
	);
}

// --- Claim Cell ---

function ClaimCell({ workloadName, disabled, onClaim }: { workloadName: string; disabled?: boolean; onClaim?: (source: string) => void }) {
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
			onClaim?.(res.source);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Claim failed");
		} finally {
			setClaiming(false);
		}
	}

	if (!expanded) {
		return (
			<IconButton
				icon={UserPlus}
				title="Claim workload"
				variant="info"
				disabled={disabled}
				onClick={() => setExpanded(true)}
			/>
		);
	}

	return (
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
			<IconButton
				icon={UserPlus}
				title={claiming ? "Claiming…" : "Claim"}
				variant="info"
				disabled={claiming || !tenantId.trim()}
				onClick={handleClaim}
			/>
			{error && (
				<span className="text-xs text-status-red truncate max-w-[140px]" title={error}>
					{error}
				</span>
			)}
			{result && (
				<span className="text-xs text-accent truncate">
					{result.source} → {shortId(result.instanceId)}
				</span>
			)}
		</div>
	);
}

// --- Idle timer hook ---

function useIdleTimerPct(
	lastActivity: string | null,
	claimedAt: string | null,
	timeoutSeconds: number | null,
): number | null {
	const [pct, setPct] = useState<number | null>(null);

	useEffect(() => {
		if (!timeoutSeconds) return;
		const startStr = lastActivity ?? claimedAt;
		if (!startStr) return;

		function compute() {
			const start = new Date(startStr!).getTime();
			const elapsed = (Date.now() - start) / 1000;
			const remaining = Math.max(0, timeoutSeconds! - elapsed);
			setPct(remaining / timeoutSeconds!);
		}

		compute();
		const id = setInterval(compute, 1000);
		return () => clearInterval(id);
	}, [lastActivity, claimedAt, timeoutSeconds]);

	return pct;
}

// --- Layout constants ---

/** Width of the chevron gutter (holds chevron in workload header, empty in other rows). */
const GUTTER_W = 24;
/** Width of the status icon column. */
const STATUS_W = 16;
/** Width of the date column (right-aligned). */
const DATE_W = 88;

// --- Instance Row ---

function InstanceRow({
	instance,
	onAction,
	onConnect,
	onClaimInstance,
	workloadName,
	busy,
	idleTimeoutSeconds,
}: {
	instance: InstanceSummary;
	onAction: (id: string, action: "destroy" | "hibernate") => void;
	onConnect: (id: string, workloadName: string) => void;
	onClaimInstance?: (instanceId: string, tenantId: string, workloadName: string) => void;
	workloadName: string;
	/** When true, action buttons are replaced with a spinner. */
	busy?: boolean;
	idleTimeoutSeconds?: number | null;
}) {
	const idlePct = useIdleTimerPct(
		instance.lastActivity ?? null,
		instance.claimedAt ?? null,
		instance.tenantId && instance.status === "active" ? (idleTimeoutSeconds ?? null) : null,
	);

	return (
		<div className="relative flex items-center h-7 px-2 text-sm font-mono border-b border-border/10 overflow-hidden">
			{idlePct !== null && (
				<div
					className="absolute inset-y-0 left-0 pointer-events-none transition-[width] duration-1000 ease-linear"
					style={{ width: `${idlePct * 100}%`, backgroundColor: "rgba(255,255,255,0.06)" }}
				/>
			)}
			<span style={{ width: GUTTER_W + STATUS_W }} className="shrink-0 flex items-center justify-end pr-2">
				<StatusIndicator status={instance.status} detail={instance.statusDetail ?? undefined} />
			</span>
			<a href={`#/instances/${instance.instanceId}`} className="text-muted-light hover:text-status-blue hover:underline" title={instance.instanceId}>
				{shortId(instance.instanceId)}
			</a>
			{instance.hasSidecar && (
				<span className="text-[10px] font-mono text-muted border border-border rounded px-1 ml-1" title="Envoy proxy sidecar running">
					proxy
				</span>
			)}
			{instance.tenantId && (
				<span className="text-xs font-mono ml-2 text-muted">
					for <span className="text-foreground">{instance.tenantId}</span>
				</span>
			)}

			<span className="flex-1" />

			{instance.status !== "destroyed" && (
				busy ? (
					<Loader2 size={13} className="text-muted animate-spin mr-1" />
				) : (
					<div className="flex items-center gap-0.5">
						{instance.status === "active" && instance.tenantId !== null && (
							<>
								<IconButton icon={Plug} title="Connect" variant="info" onClick={() => onConnect(instance.instanceId, workloadName)} />
								<IconButton icon={Moon} title="Hibernate" variant="warning" onClick={() => onAction(instance.instanceId, "hibernate")} />
							</>
						)}
						{instance.status === "hibernated" && instance.tenantId !== null && (
							<IconButton
								icon={UserPlus}
								title="Claim"
								variant="info"
								onClick={() => onClaimInstance?.(instance.instanceId, instance.tenantId!, workloadName)}
							/>
						)}
						<IconButton icon={Trash2} title="Destroy" variant="danger" onClick={() => onAction(instance.instanceId, "destroy")} />
					</div>
				)
			)}

			<span style={{ width: DATE_W }} className="shrink-0 text-muted text-xs tabular-nums text-right">
				{formatDate(instance.createdAt)}
			</span>
		</div>
	);
}

// --- Pending Warm Placeholder ---

function PendingWarmRow() {
	return (
		<div className="flex items-center h-7 px-2 text-sm font-mono border-b border-border/10">
			<span style={{ width: GUTTER_W + STATUS_W }} className="shrink-0 flex items-center justify-end pr-2">
				<Loader2 size={10} className="text-muted animate-spin" />
			</span>
			<span className="text-muted text-xs">warming…</span>
		</div>
	);
}

// --- Workload Group ---

function InstanceSection({
	label,
	instances,
	onAction,
	onConnect,
	onClaimInstance,
	workloadName,
	busyInstances,
	idleTimeoutSeconds,
}: {
	label: string;
	instances: InstanceNode[];
	onAction: (id: string, action: "destroy" | "hibernate") => void;
	onConnect: (id: string, workloadName: string) => void;
	onClaimInstance?: (instanceId: string, tenantId: string, workloadName: string) => void;
	workloadName: string;
	busyInstances: Set<string>;
	idleTimeoutSeconds?: number | null;
}) {
	return (
		<>
			<div
				className="flex items-center h-6 px-2 border-b border-border/10"
				style={{ paddingLeft: GUTTER_W + STATUS_W + 8 }}
			>
				<span className="text-xs text-muted font-mono uppercase tracking-wider">{label}</span>
				<span className="text-xs text-muted font-mono ml-1.5">({instances.length})</span>
			</div>
			{instances.map((inst) => (
				<InstanceRow
					key={inst.instance.instanceId}
					instance={inst.instance}
					onAction={onAction}
					onConnect={onConnect}
					onClaimInstance={onClaimInstance}
					workloadName={workloadName}
					busy={busyInstances.has(inst.instance.instanceId)}
					idleTimeoutSeconds={idleTimeoutSeconds}
				/>
			))}
		</>
	);
}

function WorkloadGroup({
	node,
	expanded,
	onToggle,
	onAction,
	onConnect,
	onClaimInstance,
	navigate,
	busyInstances,
	onClaim,
	pendingWarm,
}: {
	node: WorkloadTreeNode;
	expanded: boolean;
	onToggle: () => void;
	onAction: (id: string, action: "destroy" | "hibernate") => void;
	onConnect: (id: string, workloadName: string) => void;
	onClaimInstance?: (instanceId: string, tenantId: string, workloadName: string) => void;
	navigate: (path: string) => void;
	busyInstances: Set<string>;
	onClaim?: (workloadId: string, source: string) => void;
	pendingWarm?: boolean;
}) {
	const { workload, poolInstances, claimedInstances } = node;
	const Chevron = expanded ? ChevronDown : ChevronRight;
	const hasInstances = poolInstances.length > 0 || claimedInstances.length > 0 || !!pendingWarm;

	return (
		<div className="mb-3">
			{/* Workload header */}
			<div className="flex items-center h-8 px-2 bg-surface-1 rounded">
				<span style={{ width: GUTTER_W }} className="shrink-0 flex items-center justify-center">
					<button
						onClick={onToggle}
						className="text-muted hover:text-white transition-colors"
					>
						<Chevron size={14} />
					</button>
				</span>
				<span style={{ width: STATUS_W }} className="shrink-0 flex items-center">
					<StatusIndicator status={workload.status} detail={workload.statusDetail ?? undefined} />
				</span>
				<a
					href={`#/workloads/${workload.name}`}
					onClick={(e) => {
						e.preventDefault();
						navigate(`/workloads/${workload.name}`);
					}}
					className="font-mono font-medium text-accent hover:text-accent-bright transition-colors"
				>
					{workload.name}
				</a>
				<span className="text-muted-light text-xs font-mono ml-2">v{workload.version}</span>
				{workload.status !== "ready" && (
					<span className="text-xs text-muted font-mono ml-2">({workload.status})</span>
				)}

				<span className="flex-1" />

				<div onClick={(e) => e.stopPropagation()}>
					<ClaimCell workloadName={workload.name} disabled={workload.status !== "ready"} onClaim={(source) => onClaim?.(workload.workloadId, source)} />
				</div>
			</div>

			{/* Expanded children */}
			{expanded && hasInstances && (
				<div className="mt-1">
					{(poolInstances.length > 0 || pendingWarm) && (
						<>
							<InstanceSection
								label="pool"
								instances={poolInstances}
								onAction={onAction}
								onConnect={onConnect}
								onClaimInstance={onClaimInstance}
								workloadName={workload.name}
								busyInstances={busyInstances}
							/>
							{pendingWarm && <PendingWarmRow />}
						</>
					)}
					{claimedInstances.length > 0 && (
						<InstanceSection
							label="claimed"
							instances={claimedInstances}
							onAction={onAction}
							onConnect={onConnect}
							onClaimInstance={onClaimInstance}
							workloadName={workload.name}
							busyInstances={busyInstances}
							idleTimeoutSeconds={workload.idleTimeoutSeconds}
						/>
					)}
				</div>
			)}
		</div>
	);
}

// --- Main Component ---

export function WorkloadList({ navigate }: { navigate: (path: string) => void }) {
	const workloadsApi = useApi<WorkloadSummary[]>(api.fetchWorkloads);
	const instancesApi = useApi<InstanceSummary[]>(useCallback(() => api.fetchInstances(), []));

	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [initialized, setInitialized] = useState(false);
	const [connectTarget, setConnectTarget] = useState<{ instanceId: string; workloadName: string } | null>(null);
	const [busyInstances, setBusyInstances] = useState<Set<string>>(new Set());
	const [pendingWarms, setPendingWarms] = useState<Set<string>>(new Set());

	// Auto-refresh when instance state changes (e.g. idle timeout fires, claim released)
	const { refetch: refetchWorkloads } = workloadsApi;
	const { refetch: refetchInstances, update: updateInstances } = instancesApi;
	useWebSocket(useCallback((event) => {
		const e = event as { type: string; instanceId?: string; workloadId?: string; tenantId?: string | null; lastActivity?: string };
		if (e.type === "instance.state" || e.type === "tenant.released" || e.type === "tenant.claimed" || e.type === "pool.instance.ready") {
			// Optimistically update lastActivity so the idle bar resets immediately
			if (e.type === "tenant.claimed" && e.instanceId) {
				const now = e.lastActivity ?? new Date().toISOString();
				updateInstances((prev) =>
					prev?.map((inst) =>
						inst.instanceId === e.instanceId ? { ...inst, lastActivity: now } : inst,
					) ?? null,
				);
			}
			// Clear pending warm once the real pool instance starts appearing
			if (e.type === "instance.state" && !e.tenantId && e.workloadId) {
				setPendingWarms((prev) => {
					if (!prev.has(e.workloadId!)) return prev;
					const next = new Set(prev);
					next.delete(e.workloadId!);
					return next;
				});
			}
			refetchWorkloads();
			refetchInstances();
		}
	}, [refetchWorkloads, refetchInstances, updateInstances]));

	const loading = workloadsApi.loading || instancesApi.loading;
	const error = workloadsApi.error || instancesApi.error;

	// Expand all workloads by default once data loads
	if (!initialized && workloadsApi.data) {
		setExpanded(new Set(workloadsApi.data.map((w) => w.workloadId)));
		setInitialized(true);
	}

	if (loading) return <LoadingState />;
	if (error) return <ErrorState message={error} />;
	if (!workloadsApi.data) return null;

	const tree = buildWorkloadTree(
		workloadsApi.data,
		instancesApi.data ?? [],
	);

	function toggleExpanded(workloadId: string) {
		setExpanded((prev) => {
			const next = new Set(prev);
			if (next.has(workloadId)) next.delete(workloadId);
			else next.add(workloadId);
			return next;
		});
	}

	function refetchAll() {
		workloadsApi.refetch();
		instancesApi.refetch();
	}

	function handleClaim(workloadId: string, source: string) {
		if (source === "pool" || source === "pool+data") {
			setPendingWarms((prev) => new Set(prev).add(workloadId));
		}
		refetchAll();
	}

	async function handleClaimInstance(instanceId: string, tenantId: string, workloadName: string) {
		setBusyInstances((prev) => new Set(prev).add(instanceId));
		try {
			await api.claimWorkload(tenantId, workloadName);
			refetchAll();
		} catch (err) {
			alert(err instanceof Error ? err.message : "Claim failed");
		} finally {
			setBusyInstances((prev) => {
				const next = new Set(prev);
				next.delete(instanceId);
				return next;
			});
		}
	}

	async function handleAction(instanceId: string, action: "destroy" | "hibernate") {
		setBusyInstances((prev) => new Set(prev).add(instanceId));
		try {
			if (action === "destroy") {
				await api.destroyInstance(instanceId);
			} else {
				await api.hibernateInstance(instanceId);
			}
			refetchAll();
		} catch (err) {
			alert(err instanceof Error ? err.message : "Action failed");
		} finally {
			setBusyInstances((prev) => {
				const next = new Set(prev);
				next.delete(instanceId);
				return next;
			});
		}
	}

	return (
		<div>
			<PageHeader>workloads</PageHeader>
			{tree.length === 0 ? (
				<p className="text-muted font-mono text-sm">no workloads registered.</p>
			) : (
				<div>
					{tree.map((node) => (
						<WorkloadGroup
							key={node.workload.workloadId}
							node={node}
							expanded={expanded.has(node.workload.workloadId)}
							onToggle={() => toggleExpanded(node.workload.workloadId)}
							onAction={handleAction}
							onConnect={(id, name) => setConnectTarget({ instanceId: id, workloadName: name })}
							onClaimInstance={handleClaimInstance}
							navigate={navigate}
							busyInstances={busyInstances}
							onClaim={handleClaim}
							pendingWarm={pendingWarms.has(node.workload.workloadId)}
						/>
					))}
				</div>
			)}

			{connectTarget && (
				<ConnectionModal
					instanceId={connectTarget.instanceId}
					workloadName={connectTarget.workloadName}
					onClose={() => setConnectTarget(null)}
				/>
			)}
		</div>
	);
}
