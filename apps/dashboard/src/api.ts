const BASE = "/api/v1";

async function get<T>(path: string): Promise<T> {
	const res = await fetch(`${BASE}${path}`);
	if (!res.ok) {
		const body = await res.json().catch(() => null);
		throw new Error(
			(body as { error?: string } | null)?.error ??
				`HTTP ${res.status}: ${res.statusText}`,
		);
	}
	return res.json() as Promise<T>;
}

async function post<T>(path: string): Promise<T> {
	const res = await fetch(`${BASE}${path}`, { method: "POST" });
	if (!res.ok) {
		const body = await res.json().catch(() => null);
		throw new Error(
			(body as { error?: string } | null)?.error ??
				`HTTP ${res.status}: ${res.statusText}`,
		);
	}
	return res.json() as Promise<T>;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
	const res = await fetch(`${BASE}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!res.ok) {
		const resBody = await res.json().catch(() => null);
		throw new Error(
			(resBody as { error?: string } | null)?.error ??
				`HTTP ${res.status}: ${res.statusText}`,
		);
	}
	return res.json() as Promise<T>;
}

// --- Types matching API responses ---

export interface StatsResponse {
	instances: Record<string, number>;
	snapshots: number;
	nodes: number;
}

export interface WorkloadSummary {
	workloadId: string;
	name: string;
	version: string;
	createdAt: string;
	updatedAt: string;
}

export interface WorkloadDetail extends WorkloadSummary {
	config: unknown;
	instanceCount: number;
}

export interface InstanceSummary {
	instanceId: string;
	workloadId: string;
	nodeId: string;
	tenantId: string | null;
	status: string;
	createdAt: string;
}

export interface InstanceDetail extends InstanceSummary {
	runtimeMeta: unknown;
	lastActivity: string | null;
	claimedAt: string | null;
}

export interface TenantSummary {
	tenantId: string;
	workloadId: string;
	instanceId: string | null;
	lastActivity: string | null;
	createdAt: string;
}

export interface TenantDetail extends TenantSummary {
	lastSnapshotId: string | null;
	instance: {
		instanceId: string;
		status: string;
		createdAt: string;
	} | null;
	snapshots: Array<{
		snapshotId: string;
		type: string;
		createdAt: string;
	}>;
}

export interface NodeSummary {
	nodeId: string;
	runtimeType: string;
	capacity: { vcpus: number; memoryMb: number; diskGb: number };
	status: string;
	lastHeartbeat: string;
	createdAt: string;
}

export interface NodeDetail extends NodeSummary {
	instanceCount: number;
}

export interface InstanceEndpoint {
	instanceId: string;
	status: string;
	endpoint: { host: string; port: number };
}

export interface SnapshotSummary {
	snapshotId: string;
	/** @example "golden" */
	type: "golden" | "tenant";
	instanceId: string;
	tenantId: string | null;
	workloadId: string;
	/** @example "minimal" */
	workloadName: string | null;
	nodeId: string;
	sizeBytes: number;
	createdAt: string;
}

export interface ClaimResult {
	tenantId: string;
	instanceId: string;
	/** @example { host: "10.0.0.1", port: 8080 } */
	endpoint: { host: string; port: number };
	/** @example "warm" */
	source: string;
	latencyMs: number;
}

// --- API methods ---

export const api = {
	fetchStats: () => get<StatsResponse>("/stats"),

	fetchWorkloads: () => get<WorkloadSummary[]>("/workloads"),

	fetchWorkload: (name: string) => get<WorkloadDetail>(`/workloads/${encodeURIComponent(name)}`),

	fetchSnapshots: () => get<SnapshotSummary[]>("/snapshots"),

	fetchWorkloadSnapshots: (name: string) =>
		get<SnapshotSummary[]>(`/workloads/${encodeURIComponent(name)}/snapshots`),

	fetchInstances: (status?: string) => {
		const qs = status ? `?status=${encodeURIComponent(status)}` : "";
		return get<InstanceSummary[]>(`/instances${qs}`);
	},

	fetchInstance: (id: string) => get<InstanceDetail>(`/instances/${encodeURIComponent(id)}`),

	fetchInstanceEndpoint: (id: string) =>
		get<InstanceEndpoint>(`/instances/${encodeURIComponent(id)}/endpoint`),

	fetchTenants: () => get<TenantSummary[]>("/tenants"),

	fetchTenant: (id: string) => get<TenantDetail>(`/tenants/${encodeURIComponent(id)}`),

	fetchNodes: () => get<NodeSummary[]>("/nodes"),

	fetchNode: (id: string) => get<NodeDetail>(`/nodes/${encodeURIComponent(id)}`),

	stopInstance: (id: string) =>
		post<{ instanceId: string; status: string }>(`/instances/${encodeURIComponent(id)}/stop`),

	hibernateInstance: (id: string) =>
		post<{ instanceId: string; status: string; snapshotId: string }>(
			`/instances/${encodeURIComponent(id)}/hibernate`,
		),

	destroyInstance: (id: string) =>
		post<{ instanceId: string; status: string }>(
			`/instances/${encodeURIComponent(id)}/destroy`,
		),

	claimWorkload: (tenantId: string, workloadName: string) =>
		postJson<ClaimResult>(`/tenants/${encodeURIComponent(tenantId)}/claim`, {
			workload: workloadName,
		}),
};
