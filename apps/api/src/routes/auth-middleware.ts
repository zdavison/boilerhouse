import { Elysia } from "elysia";

/**
 * Opt-in API key authentication middleware.
 *
 * When `apiKey` is provided, all routes require `Authorization: Bearer <key>`.
 * The `/api/v1/health` endpoint is always exempt.
 * When `apiKey` is undefined, all requests pass through (private-network default).
 */
export function authMiddleware(apiKey: string | undefined) {
	return new Elysia({ name: "auth-middleware" }).onBeforeHandle(({ request, set }) => {
		if (!apiKey) return;

		const url = new URL(request.url);
		if (url.pathname === "/api/v1/health") return;

		const authHeader = request.headers.get("Authorization");
		const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

		if (token !== apiKey) {
			set.status = 401;
			return { error: "Unauthorized" };
		}
	});
}
