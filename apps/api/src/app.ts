import { Elysia } from "elysia";
import { httpTracing } from "@boilerhouse/o11y";
import type { RouteDeps } from "./routes/deps";
import { errorHandler } from "./routes/errors";
import { systemRoutes } from "./routes/system";
import { workloadRoutes } from "./routes/workloads";
import { instanceRoutes } from "./routes/instances";
import { tenantRoutes } from "./routes/tenants";
import { nodeRoutes } from "./routes/nodes";
import { snapshotRoutes } from "./routes/snapshots";
import { activityRoutes } from "./routes/activity";
import { secretRoutes } from "./routes/secrets";
import { wsPlugin } from "./routes/ws";

export function createApp(deps: RouteDeps) {
	const app = new Elysia()
		.use(errorHandler);

	// Add HTTP tracing/metrics if OTEL providers are available
	if (deps.tracer && deps.meter) {
		app.use(httpTracing(deps.tracer, deps.meter));
	}

	return app
		.group("/api/v1", (group) =>
			group
				.use(systemRoutes(deps))
				.use(workloadRoutes(deps))
				.use(instanceRoutes(deps))
				.use(tenantRoutes(deps))
				.use(nodeRoutes(deps))
				.use(snapshotRoutes(deps))
				.use(activityRoutes(deps))
				.use(secretRoutes(deps)),
		)
		.use(wsPlugin(deps));
}
