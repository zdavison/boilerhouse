import { Elysia } from "elysia";

/**
 * Opt-in API key authentication middleware.
 *
 * When `apiKey` is provided, all routes require `Authorization: Bearer <key>`.
 * The `/api/v1/health` endpoint is always exempt.
 * When `apiKey` is undefined, all requests pass through (private-network default).
 *
 * Uses `onRequest` (runs before body parsing and schema validation) so that
 * unauthenticated requests always get 401, never 422 from body validation.
 * `.as("scoped")` propagates the hook to the parent group in app.ts.
 */
export function authMiddleware(apiKey: string | undefined) {
	return new Elysia({ name: "auth-middleware" })
		.onRequest(({ request, set }) => {
			if (!apiKey) return;

			const url = new URL(request.url);
			// Only protect /api/v1/* routes; other paths (e.g. /ws) handle auth themselves
			if (!url.pathname.startsWith("/api/v1/")) return;
			if (url.pathname === "/api/v1/health") return;

			const authHeader = request.headers.get("Authorization");
			const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

			if (token !== apiKey) {
				set.status = 401;
				return new Response(JSON.stringify({ error: "Unauthorized" }), {
					status: 401,
					headers: { "Content-Type": "application/json" },
				});
			}
		})
		.as("scoped");
}
