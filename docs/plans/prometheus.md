# Observability: Metrics, Tracing & Grafana Dashboards

## Status quo

No metrics library. Observability is limited to Pino logs, an SQLite activity log,
and the `/api/v1/stats` endpoint (instance counts + snapshot/node totals).

Logging lives in a standalone `@boilerhouse/logger` package (Pino wrapper,
`createLogger(name)` → child logger). Imported by ~8 files across the API app.

Some metric-worthy values already exist in code but aren't exposed:
- `TenantManager.claim()` returns `latencyMs` and `source`
- `ResourceLimiter` counts active instances via DB query
- `IdleMonitor` tracks watched instances and fires idle events
- `GoldenCreator` has `.pending` and `.isProcessing` accessors
- `EventBus` emits typed domain events for every state change

## Approach

Merge `@boilerhouse/logger` and the new metrics/tracing code into a single
**`@boilerhouse/o11y`** (observability) package. Logging, metrics, and
tracing all come from one place.

Use the **OpenTelemetry SDK** for both metrics and tracing:
- **Metrics** — Prometheus exporter serves `/metrics` for scraping
- **Tracing** — OTLP exporter sends spans to a collector (Jaeger/Tempo/etc)

Key npm dependencies:
- `pino` + `pino-pretty` — structured logging (already used)
- `@opentelemetry/api` — stable metrics + tracing API
- `@opentelemetry/sdk-metrics` — metrics SDK
- `@opentelemetry/exporter-prometheus` — serves `/metrics`
- `@opentelemetry/sdk-trace-base` — tracing SDK
- `@opentelemetry/exporter-trace-otlp-http` — sends spans via OTLP
- `@opentelemetry/resources` + `@opentelemetry/semantic-conventions` — shared resource attributes

## Implementation

### 1. Create `packages/o11y`, delete `packages/logger`

```
packages/o11y/
  src/
    index.ts          # re-exports everything
    logger.ts         # Pino logger (moved from packages/logger)
    provider.ts       # shared Resource + MeterProvider + TracerProvider init
    tracing/
      http.ts         # Elysia plugin: request spans + metrics
      tenants.ts      # tenant claim/release spans
      instances.ts    # instance lifecycle spans
      snapshots.ts    # snapshot creation spans
    metrics/
      tenants.ts      # tenant gauges/counters
      instances.ts    # instance gauges/counters
      snapshots.ts    # snapshot counters
      capacity.ts     # node capacity gauges
  package.json
```

**package.json**:

```json
{
  "name": "@boilerhouse/o11y",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "dependencies": {
    "pino": "^9.6.0",
    "pino-pretty": "^13.0.0",
    "@opentelemetry/api": "^1.9.0",
    "@opentelemetry/sdk-metrics": "^1.30.0",
    "@opentelemetry/exporter-prometheus": "^0.57.0",
    "@opentelemetry/sdk-trace-base": "^1.30.0",
    "@opentelemetry/exporter-trace-otlp-http": "^0.57.0",
    "@opentelemetry/resources": "^1.30.0",
    "@opentelemetry/semantic-conventions": "^1.30.0"
  }
}
```

`logger.ts` is an exact copy of the current `packages/logger/src/index.ts` —
same `createLogger()` function, same `Logger` type re-export.

After the new package is wired up, delete `packages/logger/` entirely.

### 2. Update all imports

Replace `@boilerhouse/logger` → `@boilerhouse/o11y` in all consuming files:

| File | Change |
|------|--------|
| `apps/api/src/server.ts` | `import { createLogger } from "@boilerhouse/o11y"` |
| `apps/api/src/tenant-manager.ts` | same |
| `apps/api/src/instance-manager.ts` | same |
| `apps/api/src/golden-creator.ts` | same |
| `apps/api/src/routes/deps.ts` | same |
| `apps/api/src/test-helpers.ts` | same |
| `apps/api/src/e2e/e2e-helpers.ts` | same |
| `apps/api/package.json` | Replace `@boilerhouse/logger` dep with `@boilerhouse/o11y` |

The public API (`createLogger`, `Logger` type) stays identical — this is a
pure move, no consumer code changes beyond the import path.

### 3. Provider setup (`provider.ts`)

Single init function that creates a shared `Resource` and sets up both the
`MeterProvider` (Prometheus exporter) and `TracerProvider` (OTLP exporter).
Returns a `{ meter, tracer }` pair.

```ts
import { MeterProvider } from "@opentelemetry/sdk-metrics";
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus";
import { BasicTracerProvider, BatchSpanProcessor, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { Resource } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

export interface InitOptions {
  metricsPort?: number;       // default 9464
  otlpEndpoint?: string;      // default "http://localhost:4318/v1/traces"
  tracingEnabled?: boolean;   // default true if OTEL_EXPORTER_OTLP_ENDPOINT is set
}

export function initO11y(opts: InitOptions = {}) {
  const resource = new Resource({
    [ATTR_SERVICE_NAME]: "boilerhouse",
    [ATTR_SERVICE_VERSION]: "0.0.1",
  });

  // Metrics
  const prometheusExporter = new PrometheusExporter({
    port: opts.metricsPort ?? 9464,
  });
  const meterProvider = new MeterProvider({
    resource,
    readers: [prometheusExporter],
  });
  const meter = meterProvider.getMeter("boilerhouse");

  // Tracing
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

  const tracer = tracerProvider.getTracer("boilerhouse");

  return { meter, tracer, meterProvider, tracerProvider };
}
```

Tracing is **opt-in** — enabled when `OTEL_EXPORTER_OTLP_ENDPOINT` is set.
When disabled, spans are created but never exported (no-op). This means the
instrumentation code is always active with zero overhead when no collector
is configured.

The shared `Resource` ensures metrics and traces are correlated by
service name in Grafana (Prometheus + Tempo/Jaeger data sources).

The OTEL metrics API maps cleanly to Prometheus:
- `Counter` → Prometheus counter (auto-suffixed `_total`)
- `Histogram` → Prometheus histogram (auto-generates `_bucket`, `_sum`, `_count`)
- `ObservableGauge` → Prometheus gauge (polled on scrape via callback)

### 4. Tracing — spans

Each file in `tracing/` exports functions that wrap existing manager methods
with spans. The tracer is passed in so tests can use a no-op tracer.

#### `tracing/http.ts` — Elysia plugin

An Elysia plugin that adds `onBeforeHandle` / `onAfterHandle` hooks for both
spans and metrics on every HTTP request.

**Span:** One root span per request — `HTTP {method} {route}`.

| Attribute | Value |
|-----------|-------|
| `http.request.method` | GET, POST, etc. |
| `http.route` | `/api/v1/tenants/:id/claim` (normalised) |
| `http.response.status_code` | 200, 404, 503, etc. |
| `url.path` | actual path |

**Metrics** (recorded on the same hook):

| Metric | Type | Attributes |
|--------|------|------------|
| `http.server.request.duration` | Histogram | `http.request.method`, `http.route`, `http.response.status_code` |
| `http.server.request.total` | Counter | `http.request.method`, `http.route`, `http.response.status_code` |

Uses OTEL semantic convention attribute names. The Prometheus exporter
auto-converts dots to underscores (`http_server_request_duration`).

Bucket defaults: `[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]`

The plugin normalises route paths (strips IDs → `:id`) so cardinality stays
bounded. The span is the parent for any child spans created during the
request (e.g. `tenant.claim` → `runtime.restore`).

#### `tracing/tenants.ts` — claim & release spans

Wraps `TenantManager.claim()` and `TenantManager.release()`.

**`tenant.claim` span** — the most important trace in the system:

```
tenant.claim                              [total claim latency]
├── tenant.claim.lookup                   [DB lookup for existing instance]
├── tenant.claim.resolve_source           [determine restore hierarchy]
├── runtime.restore                       [CRIU restore from snapshot]
│   └── runtime.restore.criu             [actual criu restore call]
├── instance.register_proxy               [proxy registration if needed]
└── tenant.claim.get_endpoint             [fetch container endpoint]
```

| Attribute | Value |
|-----------|-------|
| `tenant.id` | tenant ID |
| `workload.id` | workload ID |
| `claim.source` | `existing`, `snapshot`, `cold+data`, `golden` |
| `instance.id` | resulting instance ID |

On error, the span records the exception and sets status to ERROR.

**`tenant.release` span:**

```
tenant.release
├── instance.hibernate (or instance.destroy)
│   ├── runtime.snapshot                  [CRIU checkpoint]
│   └── runtime.destroy                  [container teardown]
└── tenant.release.cleanup               [DB updates]
```

| Attribute | Value |
|-----------|-------|
| `tenant.id` | tenant ID |
| `idle.action` | `hibernate` or `destroy` |

#### `tracing/instances.ts` — instance lifecycle spans

Wraps `InstanceManager` methods:

| Span name | Wraps | Key attributes |
|-----------|-------|----------------|
| `instance.create` | `InstanceManager.create()` | `instance.id`, `workload.id` |
| `instance.destroy` | `InstanceManager.destroy()` | `instance.id` |
| `instance.hibernate` | `InstanceManager.hibernate()` | `instance.id`, `snapshot.id` |
| `instance.restore` | `InstanceManager.restoreFromSnapshot()` | `instance.id`, `snapshot.id`, `snapshot.type` |

Each span wraps the full method including runtime calls, proxy
registration, and DB transitions. Runtime calls (`runtime.create`,
`runtime.start`, `runtime.snapshot`, `runtime.restore`, `runtime.destroy`)
are child spans so we can isolate container runtime latency from
boilerhouse overhead.

#### `tracing/snapshots.ts` — golden snapshot creation

Wraps `SnapshotManager.createGolden()`:

```
snapshot.create_golden                        [total golden creation time]
├── runtime.create                            [create bootstrap container]
├── runtime.start                             [start bootstrap container]
├── snapshot.health_check                     [poll until healthy]
│   └── health_check.attempt (repeated)       [individual probe calls]
├── runtime.snapshot                          [CRIU checkpoint]
└── runtime.destroy                          [teardown bootstrap]
```

| Attribute | Value |
|-----------|-------|
| `workload.id` | workload ID |
| `snapshot.id` | resulting snapshot ID |
| `health_check.type` | `exec` or `http` |
| `health_check.attempts` | number of polls before healthy |

This is the longest-running operation (minutes) — the span tree makes it
easy to see where time is spent (health check wait vs CRIU vs container
boot).

### 5. Metric definitions

Each file in `metrics/` exports an `instrument()` function that takes a `Meter`
and any dependencies it needs (EventBus, DB, etc). This keeps the o11y package
decoupled — it depends on types from `@boilerhouse/core` but not on the API
app's concrete classes.

#### `metrics/tenants.ts`

| Metric | Type | Labels |
|--------|------|--------|
| `boilerhouse.tenant.claim.duration` | Histogram (seconds) | `workload`, `source` |
| `boilerhouse.tenant.claims` | Counter | `workload`, `source`, `outcome` |
| `boilerhouse.tenant.releases` | Counter | `workload` |
| `boilerhouse.tenants.active` | ObservableGauge | `workload` |

Histogram buckets tuned for claim latency: `[0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30]`

Instrumentation: listen on `EventBus` for `tenant.claimed` and `tenant.released`
events. The claim route handler already has `latencyMs` and `source` — record
after a successful claim. For failures, add to counter with `outcome=error`.

The `tenants.active` gauge uses `meter.createObservableGauge()` with a callback
that queries the DB (`count where status = 'active'` grouped by workloadId).

#### `metrics/instances.ts`

| Metric | Type | Labels |
|--------|------|--------|
| `boilerhouse.instances` | ObservableGauge | `workload`, `node`, `status` |
| `boilerhouse.instance.transitions` | Counter | `from`, `to`, `workload` |
| `boilerhouse.idle.timeouts` | Counter | `workload`, `action` |

The gauge uses an observable callback querying the DB (group by status,
workloadId, nodeId). Transition counter increments on every `instance.state`
event from the EventBus. Idle timeout counter increments in the
`idleMonitor.onIdle` handler in `server.ts`.

#### `metrics/snapshots.ts`

| Metric | Type | Labels |
|--------|------|--------|
| `boilerhouse.snapshot.create.duration` | Histogram (seconds) | `workload`, `type` |
| `boilerhouse.snapshot.creates` | Counter | `workload`, `type`, `outcome` |
| `boilerhouse.golden.queue_depth` | ObservableGauge | — |

The golden queue depth reads from `GoldenCreator.pending`. Snapshot durations
are timed by wrapping `SnapshotManager.createGolden` and
`InstanceManager.hibernate` call sites.

#### `metrics/capacity.ts`

| Metric | Type | Labels |
|--------|------|--------|
| `boilerhouse.node.capacity.max` | ObservableGauge | `node` |
| `boilerhouse.node.capacity.used` | ObservableGauge | `node` |
| `boilerhouse.capacity.queue_depth` | ObservableGauge | `node` |

`capacity.max` is static from config. `capacity.used` queries the DB (same
query as `ResourceLimiter.countActive`). `queue_depth` reads from the
ResourceLimiter — add a `queueDepth(nodeId)` accessor.

### 6. `/metrics` endpoint

The `PrometheusExporter` starts its own HTTP server (default port 9464,
configurable via `METRICS_PORT`). No changes needed to the Elysia app —
scrape traffic stays on a separate port.

### 7. Wire up in `server.ts`

After creating managers but before `createApp()`:

```ts
import { createLogger, initO11y, instrumentFromEventBus } from "@boilerhouse/o11y";

// Start OTEL providers (metrics + tracing)
const { meter, tracer } = initO11y({
  metricsPort: Number(process.env.METRICS_PORT ?? 9464),
});

// Subscribe EventBus → metrics
instrumentFromEventBus(meter, eventBus, db, nodeId, { maxInstances });
```

The `tracer` is passed into `RouteDeps` so the HTTP plugin and route handlers
can create spans. The tracing wrappers in `tracing/tenants.ts` etc. are
applied by wrapping the manager methods in `server.ts`:

```ts
import { wrapTenantManager, wrapInstanceManager, wrapSnapshotManager } from "@boilerhouse/o11y";

// Wrap managers with tracing spans
const tracedTenantManager = wrapTenantManager(tenantManager, tracer);
const tracedInstanceManager = wrapInstanceManager(instanceManager, tracer);
const tracedSnapshotManager = wrapSnapshotManager(snapshotManager, tracer);
```

The wrapped managers have the same interface — they delegate to the original
and add spans around each call. This avoids modifying manager internals.

### 8. Add `queueDepth()` to ResourceLimiter

Small accessor on the existing class:

```ts
queueDepth(nodeId: NodeId): number {
    return this.queues.get(nodeId)?.length ?? 0;
}
```

### 9. Grafana dashboard

Create `deploy/grafana/boilerhouse.json` — a standard Grafana dashboard JSON
that users import via **Dashboards → Import → Upload JSON file**.

#### Template variables

The dashboard uses Grafana template variables so it works with any setup:

| Variable | Type | Default | Purpose |
|----------|------|---------|---------|
| `datasource` | datasource (prometheus) | — | User picks their Prometheus data source on import |
| `job` | query | `boilerhouse` | Prometheus job label; filters all queries |

Every PromQL query is scoped with `{job="$job"}` so multiple boilerhouse
instances can coexist.

#### Row: Overview (stat panels across the top)

| Panel | Type | Query |
|-------|------|-------|
| Active Tenants | stat | `sum(boilerhouse_tenants_active{job="$job"})` |
| Active Instances | stat | `sum(boilerhouse_instances{job="$job",status="active"})` |
| Capacity Used % | gauge | `sum(boilerhouse_node_capacity_used{job="$job"}) / sum(boilerhouse_node_capacity_max{job="$job"}) * 100` |
| Claims/min | stat | `sum(rate(boilerhouse_tenant_claims_total{job="$job"}[5m])) * 60` |
| Claim p95 | stat | `histogram_quantile(0.95, sum(rate(boilerhouse_tenant_claim_duration_seconds_bucket{job="$job"}[5m])) by (le))` |
| Error Rate | stat (red if >0) | `sum(rate(boilerhouse_tenant_claims_total{job="$job",outcome="error"}[5m])) / sum(rate(boilerhouse_tenant_claims_total{job="$job"}[5m]))` |

#### Row: Tenant Claims

| Panel | Type | Query |
|-------|------|-------|
| Claim Latency Percentiles | timeseries | `histogram_quantile(0.50, sum(rate(boilerhouse_tenant_claim_duration_seconds_bucket{job="$job"}[5m])) by (le))` (+ p95, p99) |
| Claims/sec by Source | timeseries (stacked) | `sum(rate(boilerhouse_tenant_claims_total{job="$job"}[5m])) by (source)` |
| Claims/sec by Outcome | timeseries (stacked) | `sum(rate(boilerhouse_tenant_claims_total{job="$job"}[5m])) by (outcome)` |
| Active Tenants by Workload | timeseries (stacked) | `sum(boilerhouse_tenants_active{job="$job"}) by (workload)` |
| Releases/sec | timeseries | `sum(rate(boilerhouse_tenant_releases_total{job="$job"}[5m])) by (workload)` |

#### Row: Instances

| Panel | Type | Query |
|-------|------|-------|
| Instances by Status | timeseries (stacked) | `sum(boilerhouse_instances{job="$job"}) by (status)` |
| Instance Transitions/sec | timeseries | `sum(rate(boilerhouse_instance_transitions_total{job="$job"}[5m])) by (to)` |
| Idle Timeouts/sec | timeseries | `sum(rate(boilerhouse_idle_timeouts_total{job="$job"}[5m])) by (action)` |
| Instances by Workload | timeseries (stacked) | `sum(boilerhouse_instances{job="$job",status="active"}) by (workload)` |

#### Row: Capacity

| Panel | Type | Query |
|-------|------|-------|
| Capacity Used vs Max | timeseries | `boilerhouse_node_capacity_used{job="$job"}` + `boilerhouse_node_capacity_max{job="$job"}` (two series) |
| Capacity Utilisation % | timeseries | `boilerhouse_node_capacity_used{job="$job"} / boilerhouse_node_capacity_max{job="$job"} * 100` |
| Queue Depth | timeseries | `boilerhouse_capacity_queue_depth{job="$job"}` |

#### Row: Snapshots

| Panel | Type | Query |
|-------|------|-------|
| Golden Creation p95 | timeseries | `histogram_quantile(0.95, sum(rate(boilerhouse_snapshot_create_duration_seconds_bucket{job="$job",type="golden"}[5m])) by (le))` |
| Snapshot Creates/sec | timeseries (stacked) | `sum(rate(boilerhouse_snapshot_creates_total{job="$job"}[5m])) by (type, outcome)` |
| Golden Queue Depth | timeseries | `boilerhouse_golden_queue_depth{job="$job"}` |

#### Row: HTTP

| Panel | Type | Query |
|-------|------|-------|
| Request Rate by Route | timeseries (stacked) | `sum(rate(http_server_request_total{job="$job"}[5m])) by (http_route)` |
| Latency Percentiles | timeseries | `histogram_quantile(0.50, sum(rate(http_server_request_duration_seconds_bucket{job="$job"}[5m])) by (le))` (+ p95, p99) |
| Latency by Route p95 | timeseries | `histogram_quantile(0.95, sum(rate(http_server_request_duration_seconds_bucket{job="$job"}[5m])) by (le, http_route))` |
| Error Rate (5xx) | timeseries | `sum(rate(http_server_request_total{job="$job",http_response_status_code=~"5.."}[5m])) by (http_route)` |

#### Row: Traces (optional — requires Tempo/Jaeger data source)

These panels only render if a Tempo or Jaeger data source is configured.
The dashboard includes a second template variable `trace_datasource`
(type: datasource, plugin: `tempo` or `jaeger`, optional).

| Panel | Type | Notes |
|-------|------|-------|
| Recent Traces | traces table | `{resource.service.name="boilerhouse"}`, sorted by duration desc |
| Claim Trace | trace view (linked) | Clicking a claim row in the tenant claims table opens the trace |

Exemplar support: the `tenant.claim.duration` histogram panel is configured
with exemplar queries so clicking a data point jumps to the corresponding
trace (requires Prometheus exemplar storage enabled).

#### Dashboard metadata

```json
{
  "__inputs": [
    { "name": "DS_PROMETHEUS", "type": "datasource", "pluginId": "prometheus" }
  ],
  "title": "Boilerhouse",
  "uid": "boilerhouse-overview",
  "version": 1,
  "tags": ["boilerhouse"],
  "templating": {
    "list": [
      { "name": "datasource", "type": "datasource", "query": "prometheus" },
      { "name": "job", "type": "custom", "current": { "value": "boilerhouse" } }
    ]
  }
}
```

The `__inputs` block triggers Grafana's import dialog to ask the user
which Prometheus data source to bind to — standard pattern for portable
dashboards.

### 10. Prometheus scrape config

Add a reference config at `deploy/prometheus/prometheus.yml`:

```yaml
scrape_configs:
  - job_name: boilerhouse
    scrape_interval: 15s
    static_configs:
      - targets: ["localhost:9464"]
```

## Metric naming conventions

Domain metrics are prefixed `boilerhouse.` (OTEL convention uses dots; the
Prometheus exporter auto-converts to underscores). HTTP metrics use OTEL
semantic conventions (`http.server.request.duration` etc).

OTEL handles Prometheus formatting automatically:
- Counters get `_total` suffix
- Histograms get `_bucket`, `_sum`, `_count` suffixes
- Unit suffixes (`_seconds`, `_bytes`) added from instrument unit metadata
- Dots → underscores in metric names
- Attributes are lowercase, low-cardinality

## Environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `METRICS_PORT` | `9464` | Prometheus exporter listen port |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | (unset) | OTLP collector URL; setting this enables trace export |

When `OTEL_EXPORTER_OTLP_ENDPOINT` is not set, tracing instrumentation is
still active (spans are created, context propagates) but spans are not
exported anywhere. Zero overhead in production until a collector is configured.

## File changes summary

| File | Change |
|------|--------|
| `packages/o11y/` | **New package** — logger + OTEL metrics + tracing + Elysia plugin |
| `packages/logger/` | **Delete** — absorbed into o11y |
| `apps/api/package.json` | Replace `@boilerhouse/logger` with `@boilerhouse/o11y` |
| `apps/api/src/server.ts` | Update import, add `initO11y`, wrap managers with tracing |
| `apps/api/src/app.ts` | Use HTTP tracing/metrics Elysia plugin |
| `apps/api/src/tenant-manager.ts` | Update import path |
| `apps/api/src/instance-manager.ts` | Update import path |
| `apps/api/src/golden-creator.ts` | Update import path |
| `apps/api/src/routes/deps.ts` | Update import path, add `tracer` to deps |
| `apps/api/src/test-helpers.ts` | Update import path |
| `apps/api/src/e2e/e2e-helpers.ts` | Update import path |
| `apps/api/src/resource-limits.ts` | Add `queueDepth()` accessor |
| `deploy/grafana/boilerhouse.json` | **New** — Grafana dashboard JSON |
| `deploy/prometheus/prometheus.yml` | **New** — reference scrape config |

## Local dev setup

For local development with tracing, run Jaeger all-in-one:

```sh
podman run -d --name jaeger \
  -p 4318:4318 \       # OTLP HTTP receiver
  -p 16686:16686 \      # Jaeger UI
  jaegertracing/jaeger:latest
```

Then start boilerhouse with:

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 bun run dev
```

Traces are viewable at `http://localhost:16686`. Metrics at
`http://localhost:9464/metrics`.

## Out of scope (for now)

- Per-container resource metrics (CPU/memory per instance) — requires cAdvisor or Podman stats integration
- Alerting rules — add once we have baseline data
- Multi-node federation — current architecture is single-node
- Log correlation (injecting trace/span IDs into Pino logs) — easy follow-up
