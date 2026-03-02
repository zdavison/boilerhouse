import { Elysia } from "elysia";
import { SpanStatusCode } from "@opentelemetry/api";
import type { Tracer, Meter } from "@opentelemetry/api";

/**
 * Elysia plugin that creates a root span and records metrics for every HTTP request.
 *
 * Span: `HTTP {method} {route}`
 * Metrics: `http.server.request.duration` (histogram), `http.server.request.total` (counter)
 */
export function httpTracing(tracer: Tracer, meter: Meter) {
	const duration = meter.createHistogram("http.server.request.duration", {
		description: "HTTP request duration",
		unit: "s",
		advice: {
			explicitBucketBoundaries: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
		},
	});

	const requestTotal = meter.createCounter("http.server.request.total", {
		description: "Total HTTP requests",
	});

	// Store start times per-request outside Elysia's type system to avoid
	// derive-to-hook type propagation issues.
	const startTimes = new WeakMap<Request, { start: number; path: string }>();

	return new Elysia({ name: "o11y-http" })
		.onRequest(({ request }) => {
			const url = new URL(request.url);
			startTimes.set(request, { start: performance.now(), path: url.pathname });
		})
		.onAfterHandle(({ request, set }) => {
			const timing = startTimes.get(request);
			if (!timing) return;
			startTimes.delete(request);

			const elapsedS = (performance.now() - timing.start) / 1000;
			const method = request.method;
			const route = normalizeRoute(timing.path);
			const statusCode = Number(set.status ?? 200);

			const attrs = {
				"http.request.method": method,
				"http.route": route,
				"http.response.status_code": statusCode,
			};

			duration.record(elapsedS, attrs);
			requestTotal.add(1, attrs);

			const span = tracer.startSpan(`HTTP ${method} ${route}`, {
				startTime: hrFromMs(timing.start),
			});
			span.setAttributes({
				...attrs,
				"url.path": timing.path,
			});
			if (statusCode >= 500) {
				span.setStatus({ code: SpanStatusCode.ERROR });
			}
			span.end(hrFromMs(performance.now()));
		})
		.onError(({ request, error, set }) => {
			const timing = startTimes.get(request);
			if (!timing) return;
			startTimes.delete(request);

			const elapsedS = (performance.now() - timing.start) / 1000;
			const method = request.method;
			const route = normalizeRoute(timing.path);
			const statusCode = Number(set.status ?? 500);

			const attrs = {
				"http.request.method": method,
				"http.route": route,
				"http.response.status_code": statusCode,
			};

			duration.record(elapsedS, attrs);
			requestTotal.add(1, attrs);

			const span = tracer.startSpan(`HTTP ${method} ${route}`, {
				startTime: hrFromMs(timing.start),
			});
			span.setAttributes({
				...attrs,
				"url.path": timing.path,
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
