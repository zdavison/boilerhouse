/**
 * Default driver — send JSON over WebSocket, return the next JSON message.
 * Preserves the original SessionManager behavior exactly.
 */

import type { Driver } from "../driver";

export const defaultDriver: Driver = {
	transport: "websocket",

	async send(endpoint, payload, _context, _config) {
		if (!endpoint.ws) {
			throw new Error("Default driver requires a WebSocket connection");
		}
		endpoint.ws.send(payload);
		return endpoint.ws.expect();
	},
};
