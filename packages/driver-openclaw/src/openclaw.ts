/**
 * OpenClaw driver — uses the OpenAI-compatible HTTP API with SSE streaming.
 *
 * POST /v1/chat/completions with Bearer token auth.
 * Streams the response via SSE, accumulates text deltas, returns the full text.
 * Session continuity via X-OpenClaw-Session-Key header.
 *
 * Options:
 *   - gatewayToken: string  (required)
 */

import type { Driver, DriverEndpoint, DriverConfig, SendContext, TriggerPayload } from "@boilerhouse/triggers";

export const openclawDriver: Driver<TriggerPayload> = {
	transport: "http",

	async handshake(endpoint: DriverEndpoint, config: DriverConfig) {
		const token = config.options.gatewayToken as string | undefined;
		if (!token) {
			throw new Error("OpenClaw driver requires options.gatewayToken");
		}

		// Verify the container is up and token works
		const probe = await fetch(`${endpoint.httpUrl}/v1/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Authorization": `Bearer ${token}`,
			},
			body: JSON.stringify({ model: "openclaw", messages: [] }),
			signal: AbortSignal.timeout(10_000),
		});
		// 400 = auth ok, bad request (empty messages). 401/403 = bad token.
		if (probe.status === 401 || probe.status === 403) {
			const body = await probe.text().catch(() => "");
			throw new Error(`OpenClaw auth failed (${probe.status}): ${body}`);
		}
		await probe.text().catch(() => {});
	},

	async send(
		endpoint: DriverEndpoint,
		payload: TriggerPayload,
		context: SendContext,
		config: DriverConfig,
	) {
		const token = config.options.gatewayToken as string;

		const res = await fetch(`${endpoint.httpUrl}/v1/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"Authorization": `Bearer ${token}`,
				"X-OpenClaw-Session-Key": context.tenantId,
			},
			body: JSON.stringify({
				model: "openclaw",
				messages: [{ role: "user", content: payload.text }],
				stream: true,
			}),
		});

		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throw new Error(`OpenClaw API error ${res.status}: ${body}`);
		}

		// Read SSE stream, accumulate text deltas
		const reader = res.body?.getReader();
		if (!reader) {
			throw new Error("OpenClaw API returned no body");
		}

		const decoder = new TextDecoder();
		let buffer = "";
		let fullText = "";

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });

			const lines = buffer.split("\n");
			buffer = lines.pop()!;

			for (const line of lines) {
				if (!line.startsWith("data: ")) continue;
				const data = line.slice(6);
				if (data === "[DONE]") continue;

				try {
					const chunk = JSON.parse(data) as {
						choices?: Array<{ delta?: { content?: string } }>;
					};
					const content = chunk.choices?.[0]?.delta?.content;
					if (content) {
						fullText += content;
					}
				} catch {
					// skip malformed chunks
				}
			}
		}

		return { text: fullText };
	},
};
