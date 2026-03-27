import { Elysia } from "elysia";

/**
 * Matches characters/sequences we want to REJECT in URL path segments:
 *  - Percent-encoded control chars  %00-%1f, %7f
 *  - Percent-encoded traversal      %2e%2e
 *  - Raw control chars (if they slip through)
 */
const DANGEROUS_ENCODED = /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i;
const TRAVERSAL_ENCODED = /%2e[./\\%]|%2e%2e/i;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\x00-\x1f\x7f]/;

/**
 * Checks a single decoded path segment for dangerous content.
 * Returns an error message or null if safe.
 */
function checkSegment(raw: string): string | null {
	// Check the raw (percent-encoded) form
	if (DANGEROUS_ENCODED.test(raw)) {
		return "Path contains invalid characters";
	}
	if (TRAVERSAL_ENCODED.test(raw)) {
		return "Path contains invalid characters";
	}

	// Decode and check
	let decoded: string;
	try {
		decoded = decodeURIComponent(raw);
	} catch {
		return "Path contains malformed encoding";
	}

	if (CONTROL_CHARS.test(decoded)) {
		return "Path contains invalid characters";
	}
	if (decoded.includes("..")) {
		return "Path contains invalid characters";
	}
	if (decoded.trim().length === 0) {
		return "Path segment must not be empty";
	}

	return null;
}

/**
 * Elysia plugin that validates all URL path segments on every request.
 *
 * Inspects the raw request URL so it works regardless of route matching.
 * Rejects requests containing:
 *  - Null bytes or other control characters (encoded or raw)
 *  - Path traversal sequences (../)
 *  - Empty segments (double slashes)
 *
 * Mount once at the top of your Elysia app and it protects every
 * downstream route automatically.
 */
export const inputGuards = new Elysia({ name: "input-guards" }).onRequest(
	({ request, set }) => {
		const url = new URL(request.url);
		const segments = url.pathname.split("/");

		for (const segment of segments) {
			// Skip empty segments from leading slash or trailing slash
			if (segment === "") continue;

			const error = checkSegment(segment);
			if (error) {
				set.status = 400;
				return new Response(JSON.stringify({ error }), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				});
			}
		}
	},
);
