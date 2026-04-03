import type { K8sObjectMeta } from "@boilerhouse/k8s";

// ── API constants ────────────────────────────────────────────────────────────

export const API_GROUP = "boilerhouse.dev";
export const API_VERSION = "v1alpha1";

/** Finalizer name applied to all Boilerhouse CRs by the operator. */
export const FINALIZER = "boilerhouse.dev/cleanup";

// ── BoilerhouseWorkload ──────────────────────────────────────────────────────

export interface BoilerhouseWorkloadSpec {
	version: string;
	image: {
		ref: string;
	};
	resources?: {
		vcpus?: number;
		memoryMb?: number;
		diskGb?: number;
	};
	network?: {
		access?: "none" | "restricted" | "unrestricted";
		expose?: Array<{ guest: number }>;
		allowlist?: string[];
		credentials?: Array<{
			domain: string;
			secretRef: { name: string; key: string };
			headers: Record<string, string>;
		}>;
		websocket?: string;
	};
	filesystem?: {
		overlayDirs?: string[];
		encryptOverlays?: boolean;
	};
	idle?: {
		timeoutSeconds?: number;
		action?: "hibernate" | "destroy";
		watchDirs?: string[];
	};
	health?: {
		intervalSeconds?: number;
		unhealthyThreshold?: number;
		httpGet?: { path: string; port: number };
		exec?: { command: string[] };
	};
	entrypoint?: {
		cmd?: string;
		args?: string[];
		env?: Record<string, string>;
		workdir?: string;
	};
}

export interface BoilerhouseWorkloadStatus {
	phase?: "Creating" | "Ready" | "Error";
	detail?: string;
	observedGeneration?: number;
}

export interface BoilerhouseWorkload {
	apiVersion: `${typeof API_GROUP}/${typeof API_VERSION}`;
	kind: "BoilerhouseWorkload";
	metadata: K8sObjectMeta & {
		resourceVersion?: string;
		generation?: number;
		finalizers?: string[];
		deletionTimestamp?: string;
	};
	spec: BoilerhouseWorkloadSpec;
	status?: BoilerhouseWorkloadStatus;
}

// ── BoilerhousePool ──────────────────────────────────────────────────────────

export interface BoilerhousePoolSpec {
	workloadRef: string;
	size: number;
	maxFillConcurrency?: number;
}

export interface BoilerhousePoolStatus {
	ready?: number;
	warming?: number;
	phase?: "Healthy" | "Degraded" | "Error";
	detail?: string;
}

export interface BoilerhousePool {
	apiVersion: `${typeof API_GROUP}/${typeof API_VERSION}`;
	kind: "BoilerhousePool";
	metadata: K8sObjectMeta & {
		resourceVersion?: string;
		generation?: number;
		finalizers?: string[];
		deletionTimestamp?: string;
	};
	spec: BoilerhousePoolSpec;
	status?: BoilerhousePoolStatus;
}

// ── BoilerhouseClaim ─────────────────────────────────────────────────────────

export interface BoilerhouseClaimSpec {
	tenantId: string;
	workloadRef: string;
	resume?: boolean;
}

export interface BoilerhouseClaimStatus {
	phase?: "Pending" | "Active" | "Releasing" | "Released" | "Error";
	instanceId?: string;
	endpoint?: {
		host: string;
		port: number;
	};
	source?: "pool" | "cold";
	claimedAt?: string;
	detail?: string;
}

export interface BoilerhouseClaim {
	apiVersion: `${typeof API_GROUP}/${typeof API_VERSION}`;
	kind: "BoilerhouseClaim";
	metadata: K8sObjectMeta & {
		resourceVersion?: string;
		generation?: number;
		finalizers?: string[];
		deletionTimestamp?: string;
	};
	spec: BoilerhouseClaimSpec;
	status?: BoilerhouseClaimStatus;
}

// ── BoilerhouseTrigger ───────────────────────────────────────────────────────

export interface BoilerhouseTriggerSpec {
	type: "webhook" | "slack" | "telegram" | "cron";
	workloadRef: string;
	tenant?: {
		from: "event" | "fixed";
		prefix?: string;
		id?: string;
	};
	driver?: string;
	driverOptions?: Record<string, unknown>;
	guards?: Array<{
		type: string;
		config?: Record<string, unknown>;
	}>;
	config?: Record<string, unknown>;
}

export interface BoilerhouseTriggerStatus {
	phase?: "Active" | "Error";
	detail?: string;
}

export interface BoilerhouseTrigger {
	apiVersion: `${typeof API_GROUP}/${typeof API_VERSION}`;
	kind: "BoilerhouseTrigger";
	metadata: K8sObjectMeta & {
		resourceVersion?: string;
		generation?: number;
		finalizers?: string[];
		deletionTimestamp?: string;
	};
	spec: BoilerhouseTriggerSpec;
	status?: BoilerhouseTriggerStatus;
}
