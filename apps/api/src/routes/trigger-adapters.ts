import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import type { TenantId, WorkloadId, InstanceId } from "@boilerhouse/core";
import { triggers, workloads } from "@boilerhouse/db";
import {
	Dispatcher,
	SessionManager,
	CronAdapter,
	createWebhookRoutes,
	createSlackRoutes,
	createTelegramRoutes,
	registerTelegramWebhooks,
} from "@boilerhouse/triggers";
import type {
	DispatcherDeps,
	TriggerDefinition,
	WebhookConfig,
	SlackConfig,
	TelegramConfig,
	CronConfig,
} from "@boilerhouse/triggers";
import type { RouteDeps } from "./deps";
import { createRateLimiter } from "./rate-limit";

/**
 * Creates DispatcherDeps that wire directly into the API server's managers.
 * No HTTP round-trips — claims and logging happen in-process.
 */
function createDispatcherDeps(deps: RouteDeps): DispatcherDeps {
	return {
		async claim(tenantId: string, workloadName: string) {
			const workloadRow = deps.db
				.select()
				.from(workloads)
				.where(eq(workloads.name, workloadName))
				.get();

			if (!workloadRow) {
				throw new Error(`Workload '${workloadName}' not found`);
			}
			if (workloadRow.status !== "ready") {
				throw new Error(`Workload '${workloadName}' is not ready (status: ${workloadRow.status})`);
			}

			const result = await deps.tenantManager.claim(
				tenantId as TenantId,
				workloadRow.workloadId,
			);

			deps.eventBus.emit({
				type: "tenant.claimed",
				tenantId: tenantId as TenantId,
				instanceId: result.instanceId,
				workloadId: workloadRow.workloadId,
				source: result.source,
			});

			const websocketPath = workloadRow.config.network?.websocket;

			return {
				tenantId: result.tenantId,
				instanceId: result.instanceId,
				endpoint: result.endpoint,
				source: result.source,
				latencyMs: result.latencyMs,
				...(websocketPath ? { websocket: websocketPath } : {}),
			};
		},

		logActivity(entry) {
			try {
				deps.activityLog.log({
					event: entry.event,
					tenantId: (entry.tenantId ?? null) as TenantId | null,
					instanceId: (entry.instanceId ?? null) as InstanceId | null,
					workloadId: (entry.workloadId ?? null) as WorkloadId | null,
					nodeId: deps.nodeId,
					metadata: entry.metadata ?? null,
				});
			} catch {
				// Fire-and-forget: don't let logging failures disrupt dispatch
			}
		},
	};
}

/** Load trigger definitions from the database into the config shape adapters expect. */
function loadTriggersFromDb(deps: RouteDeps): TriggerDefinition[] {
	const rows = deps.db
		.select()
		.from(triggers)
		.where(eq(triggers.enabled, 1))
		.all();

	return rows.map((row) => ({
		name: row.name,
		type: row.type as TriggerDefinition["type"],
		tenant: row.tenant as TriggerDefinition["tenant"],
		workload: row.workload,
		config: row.config as unknown as TriggerDefinition["config"],
	}));
}

/**
 * Elysia plugin that mounts trigger adapter routes (webhook, slack, telegram)
 * and starts cron jobs. Reads trigger definitions from the database.
 *
 * Adapter routes are mounted outside the /api/v1 group — they are public-facing
 * endpoints that receive external events (e.g. /hooks/deploy-agent, /slack/events).
 */
export function triggerAdapterPlugin(deps: RouteDeps) {
	const dispatcherDeps = createDispatcherDeps(deps);
	const sessionManager = new SessionManager();
	const dispatcher = new Dispatcher(dispatcherDeps, { sessionManager });

	const allTriggers = loadTriggersFromDb(deps);
	deps.log?.info({ count: allTriggers.length }, "Loaded trigger definitions from database");

	// Group by type
	const webhookTriggers = allTriggers.filter(
		(t): t is TriggerDefinition & { config: WebhookConfig } => t.type === "webhook",
	);
	const slackTriggers = allTriggers.filter(
		(t): t is TriggerDefinition & { config: SlackConfig } => t.type === "slack",
	);
	const telegramTriggers = allTriggers.filter(
		(t): t is TriggerDefinition & { config: TelegramConfig } => t.type === "telegram",
	);
	const cronTriggers = allTriggers.filter(
		(t): t is TriggerDefinition & { config: CronConfig } => t.type === "cron",
	);

	// Build adapter routes (these return Record<string, handler>)
	const webhookRoutes = createWebhookRoutes(webhookTriggers, dispatcher);
	const slackRoutes = createSlackRoutes(slackTriggers, dispatcher);
	const telegramRoutes = createTelegramRoutes(telegramTriggers, dispatcher);

	// Start cron adapter
	const cronAdapter = new CronAdapter();
	if (cronTriggers.length > 0) {
		cronAdapter.start(cronTriggers, dispatcher);
		deps.log?.info({ count: cronTriggers.length }, "Started cron triggers");
	}

	// Register Telegram webhooks if public URL is set
	const publicUrl = process.env.TRIGGERS_PUBLIC_URL;
	if (telegramTriggers.length > 0 && publicUrl) {
		registerTelegramWebhooks(telegramTriggers, publicUrl).catch((err) => {
			deps.log?.error({ err }, "Failed to register Telegram webhooks");
		});
	}

	// Build per-path rate limiters from trigger configs.
	// Webhook and Telegram have one route per trigger; Slack shares /slack/events.
	const DEFAULT_RATE_LIMIT = { max: 60, windowMs: 60_000 };
	const pathRateLimiters = new Map<string, ReturnType<typeof createRateLimiter>>();

	for (const t of webhookTriggers) {
		const rl = t.config.rateLimit ?? DEFAULT_RATE_LIMIT;
		pathRateLimiters.set(t.config.path, createRateLimiter(rl));
	}
	for (const t of telegramTriggers) {
		const rl = t.config.rateLimit ?? DEFAULT_RATE_LIMIT;
		pathRateLimiters.set(`/telegram/${t.name}`, createRateLimiter(rl));
	}
	if (slackTriggers.length > 0) {
		const rl = slackTriggers.find((t) => t.config.rateLimit)?.config.rateLimit ?? DEFAULT_RATE_LIMIT;
		pathRateLimiters.set("/slack/events", createRateLimiter(rl));
	}

	// Mount all adapter routes as Elysia routes with per-trigger rate limiting
	const app = new Elysia({ name: "trigger-adapters" });

	const allRoutes = { ...webhookRoutes, ...slackRoutes, ...telegramRoutes };
	for (const [path, handler] of Object.entries(allRoutes)) {
		const limiter = pathRateLimiters.get(path) ?? createRateLimiter(DEFAULT_RATE_LIMIT);
		app.post(path, async ({ request, set }) => {
			const ip =
				request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
				request.headers.get("x-real-ip") ??
				"unknown";
			const result = limiter(ip);
			Object.assign(set.headers, result.headers);
			if (result.limited) {
				set.status = 429;
				set.headers["Retry-After"] = String(result.retryAfter);
				return { error: "Too many requests" };
			}
			return handler(request);
		});
	}

	// Graceful shutdown
	process.on("SIGINT", () => {
		sessionManager.closeAll();
		cronAdapter.stop();
	});
	process.on("SIGTERM", () => {
		sessionManager.closeAll();
		cronAdapter.stop();
	});

	return app;
}
