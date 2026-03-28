import type { Guard, GuardContext, GuardResult } from "@boilerhouse/triggers";

/**
 * Allowlist guard — rejects any tenant not in a static list.
 *
 * Matches against the resolved `tenantId`, which is adapter-agnostic.
 * Comparison is case-insensitive.
 *
 * @example
 * guardOptions: {
 *   tenantIds: ["tg-thingsdoer", "tg-alice"],
 *   denyMessage: "You are not authorised to use this service.",
 * }
 */
const allowlistGuard: Guard = {
	async check(ctx: GuardContext): Promise<GuardResult> {
		const tenantIds = ctx.options.tenantIds;
		if (!Array.isArray(tenantIds)) {
			return { ok: false, message: "Guard misconfigured: tenantIds must be an array." };
		}

		const normalised = ctx.tenantId.toLowerCase();
		if (tenantIds.some((id: string) => id.toLowerCase() === normalised)) {
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
