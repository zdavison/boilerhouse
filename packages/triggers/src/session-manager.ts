/**
 * Manages persistent WebSocket sessions between the trigger layer
 * and container endpoints, keyed by tenant ID.
 *
 * Each session is associated with a Driver that handles protocol
 * translation (handshake, message framing, response collection).
 *
 * Sequential mode: one message at a time per session.
 * Messages arriving while a previous one is in-flight are queued.
 */

import type { Driver, DriverConfig, DriverEndpoint, SendContext } from "./driver";
import { DriverSocketImpl } from "./driver-socket";
import { defaultDriver } from "./drivers/default";

interface PendingMessage {
	payload: unknown;
	context: SendContext;
	resolve: (response: unknown) => void;
	reject: (err: Error) => void;
}

interface Session {
	ws: WebSocket;
	driverSocket: DriverSocketImpl;
	driver: Driver;
	driverConfig: DriverConfig;
	wsPath: string;
	endpoint: { host: string; port: number };
	/** Currently waiting for a response. */
	inflight: PendingMessage | null;
	/** Queued messages waiting to be sent. */
	queue: PendingMessage[];
}

export class SessionManager {
	private sessions: Map<string, Session> = new Map();
	/** In-flight session creation promises to prevent duplicate connections. */
	private connecting: Map<string, Promise<Session>> = new Map();

	/**
	 * Send a message over a persistent WebSocket session for the given tenant.
	 * Creates the session if it doesn't exist or if the previous one closed.
	 */
	async send(
		tenantId: string,
		endpoint: { host: string; port: number },
		wsPath: string,
		payload: unknown,
		options?: {
			driver?: Driver;
			driverConfig?: DriverConfig;
			context?: SendContext;
		},
	): Promise<unknown> {
		const driver = options?.driver ?? defaultDriver;
		const driverConfig = options?.driverConfig ?? { options: {} };
		const context: SendContext = options?.context ?? {
			tenantId,
			triggerName: "unknown",
			eventId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		};

		let session = this.sessions.get(tenantId);

		// If we have a session but endpoint/path changed or WS is closed, remove it
		if (session) {
			const endpointChanged =
				session.endpoint.host !== endpoint.host ||
				session.endpoint.port !== endpoint.port ||
				session.wsPath !== wsPath;

			if (endpointChanged || session.ws.readyState === WebSocket.CLOSED || session.ws.readyState === WebSocket.CLOSING) {
				this.removeSession(tenantId);
				session = undefined;
			}
		}

		// Session not yet open (still CONNECTING) or doesn't exist — wait for creation
		if (!session || session.ws.readyState !== WebSocket.OPEN) {
			let pending = this.connecting.get(tenantId);
			if (!pending) {
				pending = this.createSession(tenantId, endpoint, wsPath, driver, driverConfig);
				this.connecting.set(tenantId, pending);
			}
			try {
				session = await pending;
			} finally {
				this.connecting.delete(tenantId);
			}
		}

		return this.enqueue(session, payload, context);
	}

	/** Remove a session and close the WebSocket. */
	remove(tenantId: string): void {
		this.removeSession(tenantId);
	}

	/** Close all sessions. */
	closeAll(): void {
		for (const [tenantId] of this.sessions) {
			this.removeSession(tenantId);
		}
	}

	/** Number of active sessions. */
	get size(): number {
		return this.sessions.size;
	}

	private buildDriverEndpoint(endpoint: { host: string; port: number }, ws: DriverSocketImpl): DriverEndpoint {
		return {
			httpUrl: `http://${endpoint.host}:${endpoint.port}`,
			ws,
		};
	}

	private async createSession(
		tenantId: string,
		endpoint: { host: string; port: number },
		wsPath: string,
		driver: Driver,
		driverConfig: DriverConfig,
	): Promise<Session> {
		const url = `ws://${endpoint.host}:${endpoint.port}${wsPath}`;
		const ws = new WebSocket(url);
		const driverSocket = new DriverSocketImpl(ws);

		const session: Session = {
			ws,
			driverSocket,
			driver,
			driverConfig,
			wsPath,
			endpoint,
			inflight: null,
			queue: [],
		};

		this.sessions.set(tenantId, session);

		// Wait for the WebSocket to open
		const connectResult = await new Promise<{ ok: true } | { ok: false; error: string }>((resolve) => {
			ws.onopen = () => {
				ws.onerror = null;
				resolve({ ok: true });
			};
			ws.onerror = (e) => {
				ws.onopen = null;
				this.sessions.delete(tenantId);
				resolve({
					ok: false,
					error: e instanceof ErrorEvent ? e.message : "connection error",
				});
			};
		});

		if (!connectResult.ok) {
			driverSocket.dispose();
			throw new SessionError(
				`WebSocket connection failed to ${url}: ${connectResult.error}`,
			);
		}

		// Run driver handshake if defined
		if (driver.handshake) {
			try {
				await driver.handshake(this.buildDriverEndpoint(endpoint, driverSocket), driverConfig);
			} catch (err) {
				this.removeSession(tenantId);
				throw new SessionError(
					`Driver handshake failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		// Handle close — reject inflight, reject all queued, remove session
		ws.addEventListener("close", () => {
			if (session.inflight) {
				session.inflight.reject(new SessionError("WebSocket closed while waiting for response"));
				session.inflight = null;
			}
			for (const pending of session.queue) {
				pending.reject(new SessionError("WebSocket closed while message was queued"));
			}
			session.queue = [];
			driverSocket.dispose();
			this.sessions.delete(tenantId);
		});

		// Handle errors — close triggers cleanup above
		ws.addEventListener("error", () => {
			ws.close();
		});

		return session;
	}

	private enqueue(session: Session, payload: unknown, context: SendContext): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const pending: PendingMessage = { payload, context, resolve, reject };

			if (session.inflight) {
				session.queue.push(pending);
			} else {
				this.sendPending(session, pending);
			}
		});
	}

	private sendPending(session: Session, pending: PendingMessage): void {
		session.inflight = pending;

		if (session.ws.readyState !== WebSocket.OPEN) {
			session.inflight = null;
			pending.reject(new SessionError(
				`WebSocket not open (readyState=${session.ws.readyState})`,
			));
			return;
		}

		// Delegate to the driver — it handles framing, sending, and collecting
		session.driver
			.send(this.buildDriverEndpoint(session.endpoint, session.driverSocket), pending.payload, pending.context, session.driverConfig)
			.then((response) => {
				session.inflight = null;
				pending.resolve(response);
				this.processQueue(session);
			})
			.catch((err) => {
				session.inflight = null;
				pending.reject(
					err instanceof Error ? err : new SessionError(String(err)),
				);
				this.processQueue(session);
			});
	}

	private processQueue(session: Session): void {
		if (session.queue.length === 0) return;
		const next = session.queue.shift()!;
		this.sendPending(session, next);
	}

	private removeSession(tenantId: string): void {
		const session = this.sessions.get(tenantId);
		if (!session) return;

		this.sessions.delete(tenantId);

		if (session.inflight) {
			session.inflight.reject(new SessionError("Session removed"));
			session.inflight = null;
		}
		for (const pending of session.queue) {
			pending.reject(new SessionError("Session removed"));
		}
		session.queue = [];

		session.driverSocket.dispose();
		if (session.ws.readyState === WebSocket.OPEN || session.ws.readyState === WebSocket.CONNECTING) {
			session.ws.close();
		}
	}
}

export class SessionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SessionError";
	}
}
