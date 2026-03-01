import { useState, useCallback } from "react";
import { ChevronDown, ChevronRight, Plug, Moon, Trash2, UserPlus, Loader2 } from "lucide-react";
import { useApi } from "../hooks";
import {
	api,
	type WorkloadSummary,
	type SnapshotSummary,
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

interface TenantSnapshotNode {
	snapshot: SnapshotSummary;
	instances: InstanceNode[];
}

interface GoldenSnapshotNode {
	snapshot: SnapshotSummary;
	unclaimedInstances: InstanceNode[];
	tenantSnapshots: TenantSnapshotNode[];
}

interface WorkloadTreeNode {
	workload: WorkloadSummary;
	golden: GoldenSnapshotNode | null;
	/** Claimed instances whose tenantId doesn't match any tenant snapshot */
	orphanInstances: InstanceNode[];
}

// --- Tree builder ---

function buildWorkloadTree(
	workloads: WorkloadSummary[],
	snapshots: SnapshotSummary[],
	instances: InstanceSummary[],
): WorkloadTreeNode[] {
	const snapshotsByWorkload = new Map<string, SnapshotSummary[]>();
	for (const s of snapshots) {
		const list = snapshotsByWorkload.get(s.workloadId) ?? [];
		list.push(s);
		snapshotsByWorkload.set(s.workloadId, list);
	}

	const instancesByWorkload = new Map<string, InstanceSummary[]>();
	for (const inst of instances) {
		if (inst.status === "destroyed" || inst.status === "hibernated") continue;
		const list = instancesByWorkload.get(inst.workloadId) ?? [];
		list.push(inst);
		instancesByWorkload.set(inst.workloadId, list);
	}

	return workloads.map((workload) => {
		const wSnapshots = snapshotsByWorkload.get(workload.workloadId) ?? [];
		const wInstances = instancesByWorkload.get(workload.workloadId) ?? [];

		const goldenSnap = wSnapshots.find((s) => s.type === "golden") ?? null;
		const tenantSnaps = wSnapshots.filter((s) => s.type === "tenant");

		const tenantSnapByTenantId = new Map<string, SnapshotSummary>();
		for (const ts of tenantSnaps) {
			if (ts.tenantId) {
				tenantSnapByTenantId.set(ts.tenantId, ts);
			}
		}

		const unclaimed: InstanceNode[] = [];
		const orphans: InstanceNode[] = [];
		const tenantInstanceMap = new Map<string, InstanceNode[]>();

		for (const inst of wInstances) {
			if (!inst.tenantId) {
				unclaimed.push({ instance: inst });
			} else {
				const matchingSnap = tenantSnapByTenantId.get(inst.tenantId);
				if (matchingSnap) {
					const list = tenantInstanceMap.get(matchingSnap.snapshotId) ?? [];
					list.push({ instance: inst });
					tenantInstanceMap.set(matchingSnap.snapshotId, list);
				} else {
					// Claimed but no tenant snapshot yet — group under golden
					// (these were restored from the golden snapshot)
					unclaimed.push({ instance: inst });
				}
			}
		}

		const tenantSnapshotNodes: TenantSnapshotNode[] = tenantSnaps.map((ts) => ({
			snapshot: ts,
			instances: tenantInstanceMap.get(ts.snapshotId) ?? [],
		}));

		const golden: GoldenSnapshotNode | null = goldenSnap
			? {
					snapshot: goldenSnap,
					unclaimedInstances: unclaimed,
					tenantSnapshots: tenantSnapshotNodes,
				}
			: null;

		return {
			workload,
			golden,
			orphanInstances: golden ? orphans : [...unclaimed, ...orphans],
		};
	});
}

// --- Formatting ---

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

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

// --- Layout constants ---

/** Width of the chevron gutter (holds chevron in workload header, empty in other rows). */
const GUTTER_W = 24;
/** Width of the status icon column. */
const STATUS_W = 16;
/** Width of the label column (golden, tenant:xxx). */
const LABEL_W = 112;
/** Width of the short-ID column. */
const ID_W = 72;
/** Width of the size column (right-aligned). */
const SIZE_W = 80;
/** Width of the date column (right-aligned). */
const DATE_W = 88;
/** Indent for instance rows (past the snapshot label column). */
const INST_INDENT = 16;

// --- Snapshot Row (used for both golden and tenant snapshots) ---

function SnapshotRow({
	snapshot,
	isGolden,
}: {
	snapshot: SnapshotSummary;
	isGolden?: boolean;
}) {
	const label = isGolden ? "golden" : `tenant:${snapshot.tenantId ?? "?"}`;
	const labelColor = isGolden ? "text-status-yellow" : "text-status-blue";

	return (
		<div className={`flex items-center h-7 px-2 text-sm font-mono border-b border-border/10 ${isGolden ? "bg-status-yellow/5" : ""}`}>
			<span style={{ width: GUTTER_W }} className="shrink-0" />
			<span style={{ width: STATUS_W }} className="shrink-0 flex items-center">
				<StatusIndicator status={snapshot.status} detail={snapshot.statusDetail ?? undefined} />
			</span>
			<span style={{ width: LABEL_W }} className={`shrink-0 font-medium ${labelColor}`}>
				{label}
			</span>
			<span style={{ width: ID_W }} className="shrink-0 text-muted-light" title={snapshot.snapshotId}>
				{shortId(snapshot.snapshotId)}
			</span>

			<span className="flex-1" />

			<span style={{ width: SIZE_W }} className="shrink-0 text-muted text-xs tabular-nums text-right">
				{formatSize(snapshot.sizeBytes)}
			</span>
			<span style={{ width: DATE_W }} className="shrink-0 text-muted text-xs tabular-nums text-right">
				{formatDate(snapshot.createdAt)}
			</span>
		</div>
	);
}

// --- Instance Row ---

function InstanceRow({
	instance,
	onAction,
	onConnect,
	workloadName,
	busy,
}: {
	instance: InstanceSummary;
	onAction: (id: string, action: "hibernate" | "destroy") => void;
	onConnect: (id: string, workloadName: string) => void;
	workloadName: string;
	/** When true, action buttons are replaced with a spinner. */
	busy?: boolean;
}) {
	return (
		<div className="flex items-center h-7 px-2 text-sm font-mono border-b border-border/10">
			<span style={{ width: GUTTER_W + STATUS_W + INST_INDENT }} className="shrink-0 flex items-center justify-end pr-2">
				<StatusIndicator status={instance.status} detail={instance.statusDetail ?? undefined} />
			</span>
			<span className="text-muted-light" title={instance.instanceId}>
				{shortId(instance.instanceId)}
			</span>
			{instance.tenantId && (
				<span className="text-xs text-muted ml-2">
					tenant:<span className="text-muted-light">{instance.tenantId}</span>
				</span>
			)}

			<span className="flex-1" />

			{instance.status !== "destroyed" && (
				busy ? (
					<Loader2 size={13} className="text-muted animate-spin mr-1" />
				) : (
					<div className="flex items-center gap-0.5">
						{instance.status === "active" && (
							<>
								<IconButton icon={Plug} title="Connect" variant="info" onClick={() => onConnect(instance.instanceId, workloadName)} />
								<IconButton icon={Moon} title="Hibernate" variant="info" onClick={() => onAction(instance.instanceId, "hibernate")} />
							</>
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

// --- Workload Group ---

function WorkloadGroup({
	node,
	expanded,
	onToggle,
	onAction,
	onConnect,
	navigate,
	busyInstances,
}: {
	node: WorkloadTreeNode;
	expanded: boolean;
	onToggle: () => void;
	onAction: (id: string, action: "hibernate" | "destroy") => void;
	onConnect: (id: string, workloadName: string) => void;
	navigate: (path: string) => void;
	busyInstances: Set<string>;
}) {
	const { workload, golden, orphanInstances } = node;
	const Chevron = expanded ? ChevronDown : ChevronRight;

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

				<span className="flex-1" />

				<div onClick={(e) => e.stopPropagation()}>
					<ClaimCell workloadName={workload.name} disabled={workload.status !== "ready"} />
				</div>
			</div>

			{/* Expanded children */}
			{expanded && (
				<div className="mt-1">
					{golden && (
						<>
							<SnapshotRow snapshot={golden.snapshot} isGolden />
							{golden.unclaimedInstances.map((inst) => (
								<InstanceRow
									key={inst.instance.instanceId}
									instance={inst.instance}
									onAction={onAction}
									onConnect={onConnect}
									workloadName={workload.name}
									busy={busyInstances.has(inst.instance.instanceId)}
								/>
							))}
							{golden.tenantSnapshots.map((ts) => (
								<div key={ts.snapshot.snapshotId}>
									<SnapshotRow snapshot={ts.snapshot} />
									{ts.instances.map((inst) => (
										<InstanceRow
											key={inst.instance.instanceId}
											instance={inst.instance}
											onAction={onAction}
											onConnect={onConnect}
											workloadName={workload.name}
											busy={busyInstances.has(inst.instance.instanceId)}
										/>
									))}
								</div>
							))}
						</>
					)}
					{orphanInstances.map((inst) => (
						<InstanceRow
							key={inst.instance.instanceId}
							instance={inst.instance}
							onAction={onAction}
							onConnect={onConnect}
							workloadName={workload.name}
							busy={busyInstances.has(inst.instance.instanceId)}
						/>
					))}
				</div>
			)}
		</div>
	);
}

// --- Main Component ---

export function WorkloadList({ navigate }: { navigate: (path: string) => void }) {
	const workloadsApi = useApi<WorkloadSummary[]>(api.fetchWorkloads);
	const snapshotsApi = useApi<SnapshotSummary[]>(api.fetchSnapshots);
	const instancesApi = useApi<InstanceSummary[]>(useCallback(() => api.fetchInstances(), []));

	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const [initialized, setInitialized] = useState(false);
	const [connectTarget, setConnectTarget] = useState<{ instanceId: string; workloadName: string } | null>(null);
	const [busyInstances, setBusyInstances] = useState<Set<string>>(new Set());

	const loading = workloadsApi.loading || snapshotsApi.loading || instancesApi.loading;
	const error = workloadsApi.error || snapshotsApi.error || instancesApi.error;

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
		snapshotsApi.data ?? [],
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
		snapshotsApi.refetch();
		instancesApi.refetch();
	}

	async function handleAction(instanceId: string, action: "hibernate" | "destroy") {
		setBusyInstances((prev) => new Set(prev).add(instanceId));
		try {
			if (action === "hibernate") await api.hibernateInstance(instanceId);
			else await api.destroyInstance(instanceId);
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
							navigate={navigate}
							busyInstances={busyInstances}
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
