/**
 * DriverSocket implementation — wraps a raw WebSocket with
 * expect() and collect() helpers that drivers use to interact
 * with container protocols.
 */

import type { DriverSocket } from "./driver";

type Listener = (msg: unknown) => void;

const DEFAULT_EXPECT_TIMEOUT = 30_000;
const DEFAULT_COLLECT_TIMEOUT = 60_000;

export class DriverSocketImpl implements DriverSocket {
	private listeners: Set<Listener> = new Set();

	constructor(public readonly raw: WebSocket) {
		raw.addEventListener("message", (event) => {
			let parsed: unknown;
			try {
				parsed = JSON.parse(
					typeof event.data === "string" ? event.data : String(event.data),
				);
			} catch {
				parsed = event.data;
			}
			for (const listener of this.listeners) {
				listener(parsed);
			}
		});
	}

	send(data: unknown): void {
		this.raw.send(JSON.stringify(data));
	}

	expect(
		match?: (msg: unknown) => boolean,
		timeoutMs: number = DEFAULT_EXPECT_TIMEOUT,
	): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.listeners.delete(listener);
				reject(new DriverSocketError(`expect() timed out after ${timeoutMs}ms`));
			}, timeoutMs);

			const listener: Listener = (msg) => {
				if (match && !match(msg)) return;
				clearTimeout(timer);
				this.listeners.delete(listener);
				resolve(msg);
			};

			this.listeners.add(listener);
		});
	}

	collect(
		filter: (msg: unknown) => boolean,
		done: (msg: unknown) => boolean,
		timeoutMs: number = DEFAULT_COLLECT_TIMEOUT,
	): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.listeners.delete(listener);
				reject(
					new DriverSocketError(`collect() timed out after ${timeoutMs}ms`),
				);
			}, timeoutMs);

			const listener: Listener = (msg) => {
				if (!filter(msg)) return;
				if (done(msg)) {
					clearTimeout(timer);
					this.listeners.delete(listener);
					resolve(msg);
				}
			};

			this.listeners.add(listener);
		});
	}

	/** Remove all listeners. Called when the session is torn down. */
	dispose(): void {
		this.listeners.clear();
	}
}

export class DriverSocketError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DriverSocketError";
	}
}
