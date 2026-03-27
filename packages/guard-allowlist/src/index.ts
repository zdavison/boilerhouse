import type { Guard, GuardContext, GuardResult } from "@boilerhouse/triggers";

/**
 * Allowlist guard — rejects any sender not in a static list.
 *
 * @example
 * guardOptions: {
 *   senderIds: ["123456789", "987654321"],
 *   denyMessage: "You are not authorised to use this service.",
 * }
 */
const allowlistGuard: Guard = {
	async check(ctx: GuardContext): Promise<GuardResult> {
		const senderIds = ctx.options.senderIds;
		if (!Array.isArray(senderIds)) {
			return { ok: false, message: "Guard misconfigured: senderIds must be an array." };
		}

		const senderId = ctx.payload.senderId;
		if (senderIds.includes(senderId)) {
			return { ok: true };
		}

		const denyMessage =
			typeof ctx.options.denyMessage === "string"
				? ctx.options.denyMessage
				: "You are not authorised to use this service.";

		return { ok: false, message: denyMessage };
	},
};

export default allowlistGuard;
