import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { httpTracing } from "@boilerhouse/o11y";
import type { RouteDeps } from "./routes/deps";
import { errorHandler } from "./routes/errors";
import { securityHeaders } from "./routes/security-headers";
import { inputGuards } from "./routes/input-guards";
import { accessLog } from "./routes/access-log";
import { systemRoutes } from "./routes/system";
import { workloadRoutes } from "./routes/workloads";
import { instanceRoutes } from "./routes/instances";
import { tenantRoutes } from "./routes/tenants";
import { nodeRoutes } from "./routes/nodes";
import { activityRoutes } from "./routes/activity";
import { secretRoutes } from "./routes/secrets";
import { triggerRoutes } from "./routes/triggers";
import { triggerAdapterPlugin } from "./routes/trigger-adapters";
import { wsPlugin } from "./routes/ws";
import { authMiddleware } from "./routes/auth-middleware";

export function createApp(deps: RouteDeps) {
	const corsOrigin = process.env.CORS_ORIGIN;
	const app = new Elysia();

	// Access logging — mount first so it wraps all downstream handlers
	if (deps.log) {
		app.use(accessLog(deps.log));
	}

	app.use(errorHandler(deps.log))
		.use(securityHeaders)
		.use(cors({
			origin: corsOrigin
				? corsOrigin.split(",").map((o) => o.trim())
				: false,
			methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
			credentials: true,
		}))
		.use(inputGuards);

	// Add HTTP tracing/metrics if OTEL providers are available
	if (deps.tracer && deps.meter) {
		app.use(httpTracing(deps.tracer, deps.meter));
	}

	return app
		.group("/api/v1", (group) =>
			group
				.use(authMiddleware(deps.apiKey))
				.use(systemRoutes(deps))
				.use(workloadRoutes(deps))
				.use(instanceRoutes(deps))
				.use(tenantRoutes(deps))
				.use(nodeRoutes(deps))
					.use(activityRoutes(deps))
				.use(secretRoutes(deps))
				.use(triggerRoutes(deps)),
		)
		.use(wsPlugin(deps))
		.use(triggerAdapterPlugin(deps));
}
