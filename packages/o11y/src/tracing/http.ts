import { Elysia } from "elysia";
import { SpanStatusCode } from "@opentelemetry/api";
import type { Tracer, Meter } from "@opentelemetry/api";

/**
 * Elysia plugin that creates a root span and records metrics for every HTTP request.
 *
 * Span: `HTTP {method} {route}`
 * Metrics: `boilerhouse.http.request.duration` (histogram), `boilerhouse.http.requests` (counter)
 *
 * Uses Elysia's `derive` to store timing info on the context so it survives
 * across hooks (WeakMap<Request> fails when Elysia/Bun provides different
 * Request references between onRequest and onAfterHandle).
 */
export function httpTracing(tracer: Tracer, meter: Meter) {
	const duration = meter.createHistogram("boilerhouse.http.request.duration", {
		description: "HTTP request duration",
		unit: "s",
		advice: {
			explicitBucketBoundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
		},
	});

	const requestTotal = meter.createCounter("boilerhouse.http.requests", {
		description: "Total HTTP requests",
	});

	return new Elysia({ name: "o11y-http" })
		.derive(({ request }) => {
			const url = new URL(request.url);
			return {
				__o11yStart: performance.now(),
				__o11yPath: url.pathname,
			};
		})
		.onAfterHandle(({ request, set, __o11yStart, __o11yPath }) => {
			const elapsedS = (performance.now() - __o11yStart) / 1000;
			const method = request.method;
			const route = normalizeRoute(__o11yPath);
			const statusCode = Number(set.status ?? 200);

			const attrs = { method, route, status_code: statusCode };

			duration.record(elapsedS, attrs);
			requestTotal.add(1, attrs);

			const span = tracer.startSpan(`HTTP ${method} ${route}`, {
				startTime: hrFromMs(__o11yStart),
			});
			span.setAttributes({
				"http.request.method": method,
				"http.route": route,
				"http.response.status_code": statusCode,
				"url.path": __o11yPath,
			});
			if (statusCode >= 500) {
				span.setStatus({ code: SpanStatusCode.ERROR });
			}
			span.end(hrFromMs(performance.now()));
		})
		.onError(({ request, error, set, __o11yStart, __o11yPath }) => {
			if (__o11yStart == null) return;

			const elapsedS = (performance.now() - __o11yStart) / 1000;
			const method = request.method;
			const route = normalizeRoute(__o11yPath);
			const statusCode = Number(set.status ?? 500);

			const attrs = { method, route, status_code: statusCode };

			duration.record(elapsedS, attrs);
			requestTotal.add(1, attrs);

			const span = tracer.startSpan(`HTTP ${method} ${route}`, {
				startTime: hrFromMs(__o11yStart),
			});
			span.setAttributes({
				"http.request.method": method,
				"http.route": route,
				"http.response.status_code": statusCode,
				"url.path": __o11yPath,
			});
			const errMessage = error instanceof Error ? error.message : String(error);
			span.setStatus({ code: SpanStatusCode.ERROR, message: errMessage });
			if (error instanceof Error) {
				span.recordException(error);
			}
			span.end(hrFromMs(performance.now()));
		});
}

/**
 * Normalises a URL path by replacing UUID and numeric segments with `:id`.
 * Keeps cardinality bounded for metrics labels.
 */
function normalizeRoute(path: string): string {
	return path.replace(
		/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
		"/:id",
	).replace(
		/\/\d+/g,
		"/:id",
	);
}

/** Converts a `performance.now()` timestamp to an OTEL HrTime-compatible Date. */
function hrFromMs(ms: number): Date {
	const wallMs = Date.now() - (performance.now() - ms);
	return new Date(wallMs);
}
