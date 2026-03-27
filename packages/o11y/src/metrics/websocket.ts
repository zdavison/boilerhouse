import type { Meter, UpDownCounter } from "@opentelemetry/api";

export interface WebSocketMetrics {
	connections: UpDownCounter;
}

/**
 * Registers WebSocket metrics on the given meter.
 *
 * - `boilerhouse.ws.connections` — UpDownCounter of active WebSocket connections
 */
export function instrumentWebSocket(meter: Meter): WebSocketMetrics {
	const connections = meter.createUpDownCounter("boilerhouse.ws.connections", {
		description: "Active WebSocket connections",
	});

	return { connections };
}
