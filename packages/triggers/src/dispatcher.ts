import type { ClaimResult } from "@boilerhouse/core";
import type { Driver, DriverConfig } from "./driver";
import type { Guard } from "./guard";
import type { TriggerDefinition, TriggerPayload } from "./config";
import type { SessionManager } from "./session-manager";

export type { ClaimResult } from "@boilerhouse/core";

/** Dependencies injected into the Dispatcher. */
export interface DispatcherDeps {
	/**
	 * Claim a tenant for a workload by name.
	 * The implementation should resolve the workload name → ID,
	 * call TenantManager.claim(), and return a ClaimResult.
	 */
	claim(tenantId: string, workloadName: string): Promise<ClaimResult>;

	/** Log an activity event. Fire-and-forget — must not throw. */
	logActivity(entry: {
		event: string;
		tenantId?: string;
		instanceId?: string;
		workloadId?: string;
		metadata?: Record<string, unknown>;
	}): void;
}

/**
 * Polls the container endpoint until it accepts a connection and
 * returns an HTTP response (any status code).
 * Retries every `intervalMs` up to `timeoutMs`.
 */
export async function waitForReady(
	url: string,
	{ intervalMs = 500, timeoutMs = 15_000 } = {},
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(url, {
				method: "GET",
				signal: AbortSignal.timeout(2_000),
			});
			// Drain the body so the connection is released
			await res.text().catch(() => {});
			return;
		} catch {
			await new Promise((r) => setTimeout(r, intervalMs));
		}
	}
	throw new DispatchError(
		`Container not ready after ${timeoutMs}ms at ${url}`,
		504,
	);
}

export interface TriggerEvent {
	/** Which trigger definition fired. */
	triggerName: string;
	/** Tenant to claim. */
	tenantId: string;
	/** Workload to run. */
	workload: string;
	/** Payload to forward to the agent container. */
	payload: unknown;
	/** Optional: where to send the response (adapter handles this). */
	respond?: (response: unknown) => Promise<void>;
	/** Driver for WebSocket protocol translation. If omitted, uses the default driver. */
	driver?: Driver;
	/** Configuration passed to the driver (secrets, options). */
	driverConfig?: DriverConfig;
	/** Guard to run before claiming. If denied, respond is called and dispatch throws 403. */
	guard?: Guard;
	/** Full trigger definition, required for guard context. */
	triggerDef?: TriggerDefinition;
}

export interface DispatchResult {
	/** Response from the agent container. */
	agentResponse: unknown;
	/** Instance ID that handled the request. */
	instanceId: string;
}

export interface DispatcherOptions {
	/**
	 * Whether to poll the container endpoint for readiness before forwarding.
	 * @default true
	 */
	waitForReady?: boolean;
	/** SessionManager for persistent WebSocket connections. */
	sessionManager?: SessionManager;
}

export class Dispatcher {
	private shouldWaitForReady: boolean;
	private sessionManager: SessionManager | null;

	constructor(
		private deps: DispatcherDeps,
		options?: DispatcherOptions,
	) {
		this.shouldWaitForReady = options?.waitForReady ?? true;
		this.sessionManager = options?.sessionManager ?? null;
	}

	async dispatch(event: TriggerEvent): Promise<DispatchResult> {
		// Log trigger invocation
		this.deps.logActivity({
			event: "trigger.invoked",
			tenantId: event.tenantId,
			metadata: { trigger: event.triggerName, workload: event.workload },
		});

		// 1. Guard check — runs before claim, cron triggers have no guard
		if (event.guard && event.triggerDef) {
			let guardResult: import("./guard").GuardResult;
			try {
				guardResult = await event.guard.check({
					tenantId: event.tenantId,
					payload: event.payload as TriggerPayload,
					trigger: event.triggerDef,
					options: event.triggerDef.guardOptions ?? {},
				});
			} catch (err) {
				// Guard threw — fail closed
				const message = event.triggerDef.guardOptions?.denyMessage as string | undefined
					?? "Access denied.";
				await event.respond?.(message);
				this.deps.logActivity({
					event: "trigger.denied",
					tenantId: event.tenantId,
					metadata: { trigger: event.triggerName, reason: `guard threw: ${err instanceof Error ? err.message : String(err)}` },
				});
				throw new DispatchError(message, 403);
			}
			if (!guardResult.ok) {
				await event.respond?.(guardResult.message);
				this.deps.logActivity({
					event: "trigger.denied",
					tenantId: event.tenantId,
					metadata: { trigger: event.triggerName, reason: guardResult.message },
				});
				throw new DispatchError(guardResult.message, 403);
			}
		}

		// 3. Claim the tenant
		let claim: ClaimResult;
		try {
			claim = await this.deps.claim(event.tenantId, event.workload);
		} catch {
			// Retry once on transient failure
			try {
				claim = await this.deps.claim(event.tenantId, event.workload);
			} catch (retryErr) {
				const error = new DispatchError(
					`Failed to claim tenant ${event.tenantId}: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
					502,
				);
				this.deps.logActivity({
					event: "trigger.error",
					tenantId: event.tenantId,
					metadata: { trigger: event.triggerName, phase: "claim", reason: error.message },
				});
				throw error;
			}
		}

		if (!claim.endpoint || claim.endpoint.ports.length === 0) {
			const error = new DispatchError(
				`Container has no endpoint for tenant ${event.tenantId}`,
				502,
			);
			this.deps.logActivity({
				event: "trigger.error",
				tenantId: event.tenantId,
				instanceId: claim.instanceId,
				metadata: { trigger: event.triggerName, phase: "endpoint", reason: error.message },
			});
			throw error;
		}

		const port = claim.endpoint.ports[0]!;

		// 4. Wait for the container to be ready (skip if already running)
		const agentUrl = `http://${claim.endpoint.host}:${port}/`;
		if (this.shouldWaitForReady && claim.source !== "existing") {
			try {
				await waitForReady(agentUrl);
			} catch (err) {
				this.deps.logActivity({
					event: "trigger.error",
					tenantId: event.tenantId,
					instanceId: claim.instanceId,
					metadata: { trigger: event.triggerName, phase: "readiness", reason: err instanceof Error ? err.message : String(err) },
				});
				throw err;
			}
		}

		let agentResponse: unknown;

		const httpUrl = `http://${claim.endpoint.host}:${port}`;
		const dispatchContext = {
			tenantId: event.tenantId,
			triggerName: event.triggerName,
			eventId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		};

		// 5. Branch on transport: HTTP driver → direct call, WS driver → SessionManager, else plain POST
		const driverTransport = event.driver?.transport ?? "websocket";

		if (event.driver && driverTransport === "http") {
			// HTTP driver — call driver.send() directly, no WebSocket needed
			try {
				const endpoint = { httpUrl, ws: null };
				const driverConfig = event.driverConfig ?? { options: {} };
				if (event.driver.handshake) {
					await event.driver.handshake(endpoint, driverConfig);
				}
				agentResponse = await event.driver.send(
					endpoint,
					event.payload,
					dispatchContext,
					driverConfig,
				);
			} catch (err) {
				const error = new DispatchError(
					`HTTP driver dispatch failed for tenant ${event.tenantId}: ${err instanceof Error ? err.message : String(err)}`,
					504,
				);
				this.deps.logActivity({
					event: "trigger.error",
					tenantId: event.tenantId,
					instanceId: claim.instanceId,
					metadata: { trigger: event.triggerName, phase: "dispatch", reason: error.message },
				});
				throw error;
			}
		} else if (claim.websocket && this.sessionManager) {
			// WebSocket driver — persistent session via SessionManager
			try {
				agentResponse = await this.sessionManager.send(
					event.tenantId,
					{ host: claim.endpoint.host, port },
					claim.websocket,
					event.payload,
					{
						driver: event.driver,
						driverConfig: event.driverConfig,
						context: dispatchContext,
					},
				);
			} catch (err) {
				const error = new DispatchError(
					`WebSocket dispatch failed for tenant ${event.tenantId}: ${err instanceof Error ? err.message : String(err)}`,
					504,
				);
				this.deps.logActivity({
					event: "trigger.error",
					tenantId: event.tenantId,
					instanceId: claim.instanceId,
					metadata: { trigger: event.triggerName, phase: "dispatch", reason: error.message },
				});
				throw error;
			}
		} else {
			// Stateless HTTP POST
			let agentRes: Response;
			try {
				agentRes = await fetch(agentUrl, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(event.payload),
				});
			} catch {
				const error = new DispatchError(
					`Agent endpoint unreachable at ${agentUrl}`,
					504,
				);
				this.deps.logActivity({
					event: "trigger.error",
					tenantId: event.tenantId,
					instanceId: claim.instanceId,
					metadata: { trigger: event.triggerName, phase: "dispatch", reason: error.message },
				});
				throw error;
			}

			// Parse agent response — read as text first to avoid "Body already used"
			const rawBody = await agentRes.text();
			try {
				agentResponse = JSON.parse(rawBody);
			} catch {
				agentResponse = rawBody;
			}

			if (!agentRes.ok) {
				const error = new DispatchError(
					`Agent returned error: HTTP ${agentRes.status}`,
					agentRes.status,
					agentResponse,
				);
				this.deps.logActivity({
					event: "trigger.error",
					tenantId: event.tenantId,
					instanceId: claim.instanceId,
					metadata: { trigger: event.triggerName, phase: "dispatch", reason: error.message, status: agentRes.status },
				});
				throw error;
			}
		}

		// Log successful dispatch
		this.deps.logActivity({
			event: "trigger.dispatched",
			tenantId: event.tenantId,
			instanceId: claim.instanceId,
			metadata: { trigger: event.triggerName, source: claim.source },
		});

		return { agentResponse, instanceId: claim.instanceId };
	}
}

export class DispatchError extends Error {
	constructor(
		message: string,
		public readonly statusCode: number,
		public readonly body?: unknown,
	) {
		super(message);
		this.name = "DispatchError";
	}
}
