import type { Guard, GuardContext, GuardResult } from "@boilerhouse/triggers";

const TIMEOUT_MS = 3_000;

/**
 * API guard — POSTs to an external HTTP endpoint to make the access decision.
 *
 * @example
 * guardOptions: {
 *   url: "https://api.myapp.com/check-subscription",
 *   headers: { Authorization: "Bearer ..." },
 *   denyMessage: "No active subscription. Sign up at https://myapp.com",
 * }
 *
 * The endpoint receives:
 *   { tenantId, senderId, senderName, source }
 *
 * Expected response:
 *   { ok: true }
 *   { ok: false, message: "..." }
 *
 * If the API call fails (timeout, network error, non-2xx), the request is
 * denied with the fallback denyMessage (fail closed).
 */
const apiGuard: Guard = {
	async check(ctx: GuardContext): Promise<GuardResult> {
		const url = ctx.options.url;
		if (typeof url !== "string") {
			return { ok: false, message: "Guard misconfigured: url is required." };
		}

		const denyMessage =
			typeof ctx.options.denyMessage === "string"
				? ctx.options.denyMessage
				: "Access denied.";

		const headers: Record<string, string> = {
			"Content-Type": "application/json",
		};

		if (ctx.options.headers && typeof ctx.options.headers === "object") {
			for (const [key, value] of Object.entries(ctx.options.headers as Record<string, unknown>)) {
				if (typeof value === "string") {
					headers[key] = value;
				}
			}
		}

		const body = JSON.stringify({
			tenantId: ctx.tenantId,
			senderId: ctx.payload.senderId,
			senderName: ctx.payload.senderName,
			source: ctx.payload.source,
		});

		let res: Response;
		try {
			res = await fetch(url, {
				method: "POST",
				headers,
				body,
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
		} catch {
			// Network error or timeout — fail closed
			return { ok: false, message: denyMessage };
		}

		if (!res.ok) {
			// Non-2xx — fail closed
			return { ok: false, message: denyMessage };
		}

		let json: { ok: boolean; message?: string };
		try {
			json = await res.json() as { ok: boolean; message?: string };
		} catch {
			// Malformed JSON — fail closed
			return { ok: false, message: denyMessage };
		}

		if (json.ok) {
			return { ok: true };
		}

		return {
			ok: false,
			message: typeof json.message === "string" ? json.message : denyMessage,
		};
	},
};

export default apiGuard;
