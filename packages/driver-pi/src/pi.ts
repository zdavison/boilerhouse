/**
 * Pi agent driver — sends prompts over WebSocket to a Pi bridge server.
 *
 * Protocol (no init/handshake — container is single-tenant):
 *   → { type: "prompt", text }      send user input
 *   ← { type: "output", text }      response chunks
 *   ← { type: "idle" }              pi finished, ready for next input
 *   ← { type: "exit", code }        pi process exited
 *   ← { type: "error", message }    bridge-level error
 */

import type { Driver, DriverEndpoint, DriverConfig, SendContext, TriggerPayload } from "@boilerhouse/triggers";

interface BridgeMessage {
	type: "output" | "idle" | "exit" | "error";
	text?: string;
	code?: number;
	message?: string;
}

export const piDriver: Driver<TriggerPayload> = {
	transport: "websocket",

	async handshake(endpoint: DriverEndpoint, _config: DriverConfig) {
		if (!endpoint.ws) {
			throw new Error("Pi driver requires a WebSocket connection");
		}
	},

	async send(
		endpoint: DriverEndpoint,
		payload: TriggerPayload,
		_context: SendContext,
		_config: DriverConfig,
	) {
		const ws = endpoint.ws;
		if (!ws) {
			throw new Error("Pi driver requires a WebSocket connection");
		}

		ws.send({ type: "prompt", text: payload.text });

		let fullText = "";

		const final = await ws.collect(
			(msg) => {
				const m = msg as BridgeMessage;
				if (m.type === "output" && m.text) {
					fullText += m.text;
					return true;
				}
				return m.type === "idle" || m.type === "exit";
			},
			(msg) => {
				const m = msg as BridgeMessage;
				return m.type === "idle" || m.type === "exit";
			},
			300_000,
		);

		const finalMsg = final as BridgeMessage;
		if (finalMsg.type === "exit" && !fullText.trim()) {
			return { text: `Pi exited with code ${finalMsg.code ?? 1}` };
		}

		return { text: fullText };
	},
};
