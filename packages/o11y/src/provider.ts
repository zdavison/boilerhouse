import { MeterProvider } from "@opentelemetry/sdk-metrics";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { propagation } from "@opentelemetry/api";
import type { Meter } from "@opentelemetry/api";
import type { Tracer } from "@opentelemetry/api";

export interface InitOptions {
	/**
	 * Prometheus exporter listen port.
	 * @default 9464
	 */
	metricsPort?: number;
	/**
	 * Host to bind the Prometheus metrics endpoint to.
	 * @default "127.0.0.1"
	 */
	metricsHost?: string;
	/**
	 * OTLP collector URL for trace export.
	 * @default "http://localhost:4318/v1/traces"
	 */
	otlpEndpoint?: string;
	/**
	 * Whether to enable trace export. Defaults to true if OTEL_EXPORTER_OTLP_ENDPOINT is set.
	 * @default false
	 */
	tracingEnabled?: boolean;
	/**
	 * Whether to start the Prometheus metrics server. Set to false for processes
	 * that only need tracing (e.g. boilerhouse-podmand).
	 * @default true
	 */
	metricsEnabled?: boolean;
}

export interface O11yProviders {
	meter: Meter;
	tracer: Tracer;
	meterProvider: MeterProvider;
	tracerProvider: BasicTracerProvider;
}

export function initO11y(opts: InitOptions = {}): O11yProviders {
	const resource = new Resource({
		[ATTR_SERVICE_NAME]: "boilerhouse",
		[ATTR_SERVICE_VERSION]: "0.0.1",
	});

	// Metrics — Prometheus exporter serves /metrics (optional)
	const metricsEnabled = opts.metricsEnabled ?? true;
	const prometheusExporter = metricsEnabled
		? new PrometheusExporter({
			port: opts.metricsPort ?? 9464,
			host: opts.metricsHost ?? "127.0.0.1",
		})
		: undefined;
	const meterProvider = new MeterProvider({
		resource,
		readers: prometheusExporter ? [prometheusExporter] : [],
	});
	const meter = meterProvider.getMeter("boilerhouse");

	// Tracing — OTLP exporter sends spans to a collector
	const tracerProvider = new BasicTracerProvider({ resource });
	const tracingEnabled = opts.tracingEnabled
		?? !!process.env.OTEL_EXPORTER_OTLP_ENDPOINT;

	if (tracingEnabled) {
		const otlpExporter = new OTLPTraceExporter({
			url: opts.otlpEndpoint ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT
				?? "http://localhost:4318/v1/traces",
		});
		tracerProvider.addSpanProcessor(new BatchSpanProcessor(otlpExporter));
	}
	tracerProvider.register();

	// Register W3C trace context propagator globally so span context can be
	// injected into / extracted from HTTP headers across process boundaries.
	propagation.setGlobalPropagator(new W3CTraceContextPropagator());

	const tracer = tracerProvider.getTracer("boilerhouse");

	return { meter, tracer, meterProvider, tracerProvider };
}
