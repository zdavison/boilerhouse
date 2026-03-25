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
	/** @example "ready" */
	status: string;
	/** Error message or other status context, shown on hover. */
	statusDetail: string | null;
	/** Idle timeout in seconds, or null if not configured. */
	idleTimeoutSeconds: number | null;
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
	statusDetail: string | null;
	lastActivity: string | null;
	claimedAt: string | null;
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
	statusDetail: string | null;
	lastHeartbeat: string;
	createdAt: string;
}

export interface NodeDetail extends NodeSummary {
	instanceCount: number;
}

export interface InstanceEndpoint {
	instanceId: string;
	status: string;
	endpoint: { host: string; ports: number[] };
}


export interface ActivityLogEntry {
	id: number;
	event: string;
	instanceId: string | null;
	workloadId: string | null;
	nodeId: string | null;
	tenantId: string | null;
	metadata: Record<string, unknown> | null;
	/** @example "2026-02-21T12:00:00.000Z" */
	createdAt: string;
}

export interface BootstrapLogEntry {
	/** @example "2026-02-22T12:00:00.000Z" */
	timestamp: string;
	text: string;
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

export type TenantMapping =
	| { static: string }
	| { fromField: string; prefix?: string };

export interface TriggerSummary {
	id: string;
	name: string;
	/** @example "webhook" */
	type: string;
	tenant: TenantMapping;
	workload: string;
	config: Record<string, unknown>;
	/** 1 = enabled, 0 = disabled */
	enabled: number;
	/** @example "2026-03-13T15:24:59.634Z" */
	lastInvokedAt: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface CreateTriggerInput {
	name: string;
	type: "webhook" | "slack" | "telegram" | "cron";
	tenant: TenantMapping;
	workload: string;
	config: Record<string, unknown>;
}

export interface TriggerTestInput {
	tenantId: string;
	payload: unknown;
}

export interface TriggerTestResult {
	claim: {
		tenantId: string;
		instanceId: string;
		endpoint: { host: string; port: number };
		source: string;
		latencyMs: number;
	};
	response: {
		status: number;
		body: unknown;
	} | null;
	error?: string;
}

async function del<T>(path: string): Promise<T> {
	const res = await fetch(`${BASE}${path}`, { method: "DELETE" });
	if (!res.ok) {
		const body = await res.json().catch(() => null);
		throw new Error(
			(body as { error?: string } | null)?.error ??
				`HTTP ${res.status}: ${res.statusText}`,
		);
	}
	return res.json() as Promise<T>;
}

// --- API methods ---

export const api = {
	fetchActivity: () => get<ActivityLogEntry[]>("/audit"),

	fetchStats: () => get<StatsResponse>("/stats"),

	fetchWorkloads: () => get<WorkloadSummary[]>("/workloads"),

	fetchWorkload: (name: string) => get<WorkloadDetail>(`/workloads/${encodeURIComponent(name)}`),

	fetchBootstrapLogs: (name: string) =>
		get<BootstrapLogEntry[]>(`/workloads/${encodeURIComponent(name)}/logs`),

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

	destroyInstance: (id: string) =>
		post<{ instanceId: string; status: string }>(
			`/instances/${encodeURIComponent(id)}/destroy`,
		),

	claimWorkload: (tenantId: string, workloadName: string) =>
		postJson<ClaimResult>(`/tenants/${encodeURIComponent(tenantId)}/claim`, {
			workload: workloadName,
		}),

	// Triggers
	fetchTriggers: () => get<TriggerSummary[]>("/triggers"),

	createTrigger: (data: CreateTriggerInput) =>
		postJson<TriggerSummary>("/triggers", data),

	deleteTrigger: (id: string) =>
		del<{ ok: boolean }>(`/triggers/${encodeURIComponent(id)}`),

	enableTrigger: (id: string) =>
		post<TriggerSummary>(`/triggers/${encodeURIComponent(id)}/enable`),

	disableTrigger: (id: string) =>
		post<TriggerSummary>(`/triggers/${encodeURIComponent(id)}/disable`),

	testTrigger: (id: string, data: TriggerTestInput) =>
		postJson<TriggerTestResult>(`/triggers/${encodeURIComponent(id)}/test`, data),
};
