import { useApi } from "../hooks";
import { api, type SnapshotSummary } from "../api";
import { LoadingState, ErrorState, PageHeader } from "../components";

/**
 * Tree node representing a golden snapshot and its tenant-snapshot children.
 * Tenant snapshots are grouped under the golden snapshot that shares the same nodeId.
 */
interface SnapshotTreeNode {
	golden: SnapshotSummary;
	children: SnapshotSummary[];
}

function buildTree(snapshots: SnapshotSummary[]): {
	trees: SnapshotTreeNode[];
	orphans: SnapshotSummary[];
} {
	const golden = snapshots.filter((s) => s.type === "golden");
	const tenant = snapshots.filter((s) => s.type === "tenant");

	// Index golden snapshots by (workloadId, nodeId) for grouping
	const goldenByKey = new Map<string, SnapshotSummary>();
	for (const g of golden) {
		goldenByKey.set(`${g.workloadId}:${g.nodeId}`, g);
	}

	const childrenMap = new Map<string, SnapshotSummary[]>();
	const orphans: SnapshotSummary[] = [];

	for (const t of tenant) {
		const key = `${t.workloadId}:${t.nodeId}`;
		const parent = goldenByKey.get(key);
		if (parent) {
			const list = childrenMap.get(parent.snapshotId) ?? [];
			list.push(t);
			childrenMap.set(parent.snapshotId, list);
		} else {
			orphans.push(t);
		}
	}

	const trees: SnapshotTreeNode[] = golden.map((g) => ({
		golden: g,
		children: childrenMap.get(g.snapshotId) ?? [],
	}));

	return { trees, orphans };
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function SnapshotNode({
	snapshot,
	depth,
}: {
	snapshot: SnapshotSummary;
	depth: number;
}) {
	const isGolden = snapshot.type === "golden";
	const colorClass = isGolden ? "text-status-yellow" : "text-status-blue";
	const label = isGolden ? "golden" : "tenant";

	return (
		<div style={{ marginLeft: depth * 24 }} className="mb-1">
			<div className="flex items-center gap-2 bg-surface-2 rounded-md px-3 py-2 text-sm">
				{depth > 0 && (
					<span className="text-border-light select-none">└</span>
				)}
				<span className={`font-mono font-medium ${colorClass}`}>{label}</span>
				<span
					className="font-mono text-muted-light truncate"
					title={snapshot.snapshotId}
				>
					{snapshot.snapshotId.slice(0, 12)}…
				</span>
				{snapshot.tenantId && (
					<a
						href="#/tenants"
						className="text-xs text-muted hover:text-accent"
					>
						tenant:{" "}
						<span className="font-mono">{snapshot.tenantId}</span>
					</a>
				)}
				<span className="text-muted text-xs ml-auto flex items-center gap-3 whitespace-nowrap">
					<span>{formatSize(snapshot.sizeBytes)}</span>
					<span>{new Date(snapshot.createdAt).toLocaleString()}</span>
				</span>
			</div>
		</div>
	);
}

function SnapshotTreeView({ snapshots }: { snapshots: SnapshotSummary[] }) {
	if (snapshots.length === 0) {
		return <p className="text-muted font-mono text-sm">no snapshots found.</p>;
	}

	const { trees, orphans } = buildTree(snapshots);

	return (
		<div className="space-y-3">
			{trees.map((node) => (
				<div key={node.golden.snapshotId}>
					<div className="text-xs font-mono text-muted mb-1 px-1">
						{node.golden.workloadName ?? node.golden.workloadId}
					</div>
					<SnapshotNode snapshot={node.golden} depth={0} />
					{node.children.map((child) => (
						<SnapshotNode
							key={child.snapshotId}
							snapshot={child}
							depth={1}
						/>
					))}
				</div>
			))}
			{orphans.map((s) => (
				<SnapshotNode key={s.snapshotId} snapshot={s} depth={0} />
			))}
		</div>
	);
}

export function SnapshotList() {
	const { data, loading, error } = useApi(api.fetchSnapshots);

	if (loading) return <LoadingState />;
	if (error) return <ErrorState message={error} />;
	if (!data) return null;

	return (
		<div>
			<PageHeader>snapshots</PageHeader>
			<SnapshotTreeView snapshots={data} />
		</div>
	);
}
