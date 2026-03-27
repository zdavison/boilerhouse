/**
 * Claude Code driver — manages interactive claude sessions over WebSocket.
 *
 * Protocol:
 *   → { type: "init", tenantId }    handshake, expects ← { type: "ready" }
 *   → { type: "prompt", text }      send user input
 *   ← { type: "output", text }      streamed stdout chunks
 *   ← { type: "idle" }              claude waiting for next input
 *   ← { type: "exit", code }        claude process exited
 */

import type { Driver, DriverEndpoint, DriverConfig, SendContext, TriggerPayload } from "@boilerhouse/triggers";

interface BridgeMessage {
	type: "ready" | "output" | "idle" | "exit" | "error";
	text?: string;
	code?: number;
	message?: string;
}

export const claudeCodeDriver: Driver<TriggerPayload> = {
	transport: "websocket",

	async handshake(endpoint: DriverEndpoint, _config: DriverConfig) {
		const ws = endpoint.ws;
		if (!ws) {
			throw new Error("Claude Code driver requires a WebSocket connection");
		}

		// The SessionManager provides tenantId via the context, but at handshake
		// time we don't have it yet. Send init with a placeholder — the bridge
		// will associate the connection on the first prompt if needed.
		// For now, we just verify the WS is alive by waiting for any message
		// or sending a ping.
	},

	async send(
		endpoint: DriverEndpoint,
		payload: TriggerPayload,
		context: SendContext,
		_config: DriverConfig,
	) {
		const ws = endpoint.ws;
		if (!ws) {
			throw new Error("Claude Code driver requires a WebSocket connection");
		}

		// Ensure session is initialized for this tenant
		ws.send({ type: "init", tenantId: context.tenantId });
		await ws.expect(
			(msg) => (msg as BridgeMessage).type === "ready",
			10_000,
		);

		// Send the prompt
		ws.send({ type: "prompt", text: payload.text });

		// Collect output until claude goes idle or exits
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
			300_000, // 5 minute timeout for claude to finish thinking
		);

		const finalMsg = final as BridgeMessage;
		if (finalMsg.type === "exit") {
			// Claude exited — include exit code in response if text is empty
			if (!fullText.trim()) {
				return { text: `Claude Code exited with code ${finalMsg.code ?? 1}` };
			}
		}

		return { text: fullText };
	},
};
