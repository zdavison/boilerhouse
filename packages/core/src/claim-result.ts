import type { TenantId, InstanceId } from "./types";
import type { Endpoint } from "./runtime";

/** Source of the instance that fulfilled the claim. */
export type ClaimSource = "existing" | "cold+data" | "cold" | "pool" | "pool+data";

/** Result of claiming a tenant instance. */
export interface ClaimResult {
	tenantId: TenantId;
	instanceId: InstanceId;
	endpoint: Endpoint | null;
	source: ClaimSource;
	latencyMs: number;
	/** WebSocket path on the container, if the workload declares one. */
	websocket?: string;
}
