/**
 * Driver interface — teaches the SessionManager how to speak
 * a container's protocol without boilerhouse needing to know
 * the protocol itself.
 *
 * Shipped drivers: default (raw JSON echo), openclaw.
 * Developers can provide their own via workload config.
 */

/**
 * A Driver translates between boilerhouse trigger events and
 * whatever protocol the target container speaks.
 *
 * Drivers can use any transport (HTTP, WebSocket, etc.) — the endpoint
 * info is provided so the driver can connect however it needs to.
 *
 * @typeParam TPayload - The shape of the trigger event payload this driver expects.
 *   Defaults to `unknown` for generic/untyped usage.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface Driver<TPayload = any> {
	/**
	 * The transport this driver uses.
	 * - "http": Driver handles its own HTTP requests. The dispatcher calls
	 *   send() directly without establishing a WebSocket session.
	 * - "websocket" (default): Driver communicates over a persistent WebSocket
	 *   managed by the SessionManager.
	 */
	transport?: "http" | "websocket";

	/**
	 * Called once when a new session/connection is established.
	 * For WebSocket drivers: called after the WS connects.
	 * For HTTP drivers: called once per tenant claim (endpoint is the container URL).
	 * Throw to abort the session.
	 */
	handshake?(endpoint: DriverEndpoint, config: DriverConfig): Promise<void>;

	/**
	 * Send a trigger event payload to the container and return the response.
	 *
	 * The driver is responsible for:
	 * - Communicating with the container (HTTP, WS, etc.)
	 * - Collecting the response
	 * - Returning a value the trigger adapter can use (typically `{ text: string }`)
	 */
	send(
		endpoint: DriverEndpoint,
		payload: TPayload,
		context: SendContext,
		config: DriverConfig,
	): Promise<unknown>;
}

/**
 * Endpoint info provided to drivers. Contains both HTTP and optional
 * WebSocket access to the container.
 */
export interface DriverEndpoint {
	/** HTTP base URL for the container (e.g. "http://localhost:30042"). */
	httpUrl: string;
	/** WebSocket wrapper, if a WS connection is established. Null for HTTP-only drivers. */
	ws: DriverSocket | null;
}

/** Thin wrapper over WebSocket that drivers interact with. */
export interface DriverSocket {
	/** Send a JSON-serializable frame. */
	send(data: unknown): void;

	/**
	 * Wait for the next message, optionally matching a predicate.
	 * Resolves with the parsed message.
	 * @param match  — if provided, skips messages that don't match
	 * @param timeoutMs — default 30_000
	 */
	expect(
		match?: (msg: unknown) => boolean,
		timeoutMs?: number,
	): Promise<unknown>;

	/**
	 * Collect messages matching `filter` until `done` returns true.
	 * Returns the message that satisfied `done`.
	 * Messages that don't match `filter` are ignored (not consumed).
	 * @param timeoutMs — default 60_000, covers the entire collection
	 */
	collect(
		filter: (msg: unknown) => boolean,
		done: (msg: unknown) => boolean,
		timeoutMs?: number,
	): Promise<unknown>;

	/** The raw WebSocket, for edge cases drivers may need. */
	readonly raw: WebSocket;
}

/** Configuration passed to the driver at handshake time. */
export interface DriverConfig {
	/** Driver-specific options from trigger config. */
	options: Record<string, unknown>;
}

/** Pre-resolved drivers keyed by trigger name. Built at startup, passed to adapters. */
export type DriverMap = Map<string, { driver: Driver; driverConfig: DriverConfig }>;

/** Per-event context passed to `driver.send()`. */
export interface SendContext {
	/** Tenant ID for this event (usable as session key). */
	tenantId: string;
	/** Name of the trigger that fired. */
	triggerName: string;
	/** Unique per-event, usable as an idempotency key. */
	eventId: string;
}
