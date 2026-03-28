import { Elysia } from "elysia";
import { eq } from "drizzle-orm";
import type { TenantId, WorkloadId, InstanceId } from "@boilerhouse/core";
import { triggers, workloads } from "@boilerhouse/db";
import IORedis from "ioredis";
import {
	Dispatcher,
	SessionManager,
	CronAdapter,
	TelegramPollAdapter,
	TriggerQueueManager,
	QueuedDispatcher,
	createWebhookRoutes,
	createSlackRoutes,
	resolveDriver,
	resolveGuard,
} from "@boilerhouse/triggers";
import type {
	DispatcherDeps,
	TriggerDefinition,
	DriverMap,
	GuardMap,
	WebhookConfig,
	SlackConfig,
	TelegramPollConfig,
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
		driver: row.driver ?? undefined,
		driverOptions: row.driverOptions ?? undefined,
		guard: row.guard ?? undefined,
		guardOptions: row.guardOptions ?? undefined,
	}));
}

/**
 * Elysia plugin that mounts trigger adapter routes (webhook, slack, telegram)
 * and starts cron jobs. Reads trigger definitions from the database.
 *
 * Adapter routes are mounted outside the /api/v1 group — they are public-facing
 * endpoints that receive external events (e.g. /hooks/deploy-agent, /slack/events).
 */
/**
 * Resolve drivers for all triggers that declare one.
 * Called once at startup — imports happen here, not per-request.
 */
async function resolveDriversForTriggers(
	allTriggers: TriggerDefinition[],
	log?: RouteDeps["log"],
): Promise<DriverMap> {
	const driverMap: DriverMap = new Map();

	for (const trigger of allTriggers) {
		if (!trigger.driver) continue;
		try {
			const resolved = await resolveDriver(
				trigger.driver,
				trigger.driverOptions,
			);
			driverMap.set(trigger.name, {
				driver: resolved.driver,
				driverConfig: { options: resolved.options },
			});
			log?.info({ trigger: trigger.name, driver: trigger.driver }, "Resolved driver for trigger");
		} catch (err) {
			log?.error(
				{ trigger: trigger.name, driver: trigger.driver, err: err instanceof Error ? err.stack ?? err.message : err },
				"Failed to resolve driver for trigger — falling back to default",
			);
		}
	}

	return driverMap;
}

/**
 * Resolve guards for all triggers that declare one.
 * Called once at startup — imports happen here, not per-request.
 */
async function resolveGuardsForTriggers(
	allTriggers: TriggerDefinition[],
	log?: RouteDeps["log"],
): Promise<GuardMap> {
	const guardMap: GuardMap = new Map();

	for (const trigger of allTriggers) {
		// Cron triggers skip guards (no user to deny)
		if (trigger.type === "cron" || !trigger.guard) continue;
		try {
			const guard = await resolveGuard(trigger.guard);
			if (guard) {
				guardMap.set(trigger.name, guard);
				log?.info({ trigger: trigger.name, guard: trigger.guard }, "Resolved guard for trigger");
			}
		} catch (err) {
			log?.error(
				{ trigger: trigger.name, guard: trigger.guard, err: err instanceof Error ? err.stack ?? err.message : err },
				"Failed to resolve guard for trigger",
			);
		}
	}

	return guardMap;
}

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
	const telegramPollTriggers = allTriggers.filter(
		(t): t is TriggerDefinition & { config: TelegramPollConfig } => t.type === "telegram-poll",
	);
	const cronTriggers = allTriggers.filter(
		(t): t is TriggerDefinition & { config: CronConfig } => t.type === "cron",
	);

	// Resolve drivers and build adapter routes asynchronously.
	// Routes are populated once drivers are resolved; requests arriving
	// before that get a 503.
	let routesReady = false;
	let webhookRoutes: Record<string, (req: Request) => Promise<Response>> = {};
	let slackRoutes: Record<string, (req: Request) => Promise<Response>> = {};
	const cronAdapter = new CronAdapter();
	const telegramPollAdapter = new TelegramPollAdapter();

	deps.log?.info({
		webhook: webhookTriggers.length,
		slack: slackTriggers.length,
		telegramPoll: telegramPollTriggers.length,
		cron: cronTriggers.length,
	}, "Trigger types loaded");

	const redisUrl = process.env.REDIS_URL ?? "redis://localhost:6379";
	const redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
	let queueManager: TriggerQueueManager | null = null;

	// Register trigger queue depth gauge — callback reads from queueManager when available
	if (deps.meter) {
		const queueDepthGauge = deps.meter.createObservableGauge("boilerhouse.trigger.queue.depth", {
			description: "Number of jobs in each trigger queue",
		});
		queueDepthGauge.addCallback((result) => {
			if (!queueManager) return;
			for (const d of queueManager.getQueueDepths()) {
				result.observe(d.waiting, { trigger: d.trigger, state: "waiting" });
				result.observe(d.active, { trigger: d.trigger, state: "active" });
				result.observe(d.delayed, { trigger: d.trigger, state: "delayed" });
			}
		});
	}

	Promise.all([
		resolveDriversForTriggers(allTriggers, deps.log),
		resolveGuardsForTriggers(allTriggers, deps.log),
	]).then(([driverMap, guardMap]) => {
		// Create queue manager and register all triggers
		queueManager = new TriggerQueueManager(redis, dispatcher, driverMap);
		for (const trigger of allTriggers) {
			queueManager.register(trigger);
		}
		const queuedDispatcher = new QueuedDispatcher(queueManager);

		// Pass queuedDispatcher to adapters — structurally compatible with Dispatcher
		webhookRoutes = createWebhookRoutes(webhookTriggers, queuedDispatcher as unknown as typeof dispatcher, driverMap, guardMap);
		slackRoutes = createSlackRoutes(slackTriggers, queuedDispatcher as unknown as typeof dispatcher, driverMap, guardMap);

		if (cronTriggers.length > 0) {
			cronAdapter.start(cronTriggers, queuedDispatcher as unknown as typeof dispatcher, driverMap);
			deps.log?.info({ count: cronTriggers.length }, "Started cron triggers");
		}

		if (telegramPollTriggers.length > 0) {
			telegramPollAdapter.start(telegramPollTriggers, queuedDispatcher as unknown as typeof dispatcher, driverMap, guardMap);
			deps.log?.info({ count: telegramPollTriggers.length }, "Started telegram-poll triggers");
		}

		routesReady = true;
		deps.log?.info({ driverCount: driverMap.size, guardCount: guardMap.size }, "Trigger routes ready (queued)");
	}).catch((err) => {
		deps.log?.error({ err: err instanceof Error ? err.stack ?? err.message : err }, "Fatal: failed to initialize trigger drivers/guards");
	});

	// Build per-path rate limiters from trigger configs.
	// Webhook and Telegram have one route per trigger; Slack shares /slack/events.
	const DEFAULT_RATE_LIMIT = { max: 60, windowMs: 60_000 };
	const pathRateLimiters = new Map<string, ReturnType<typeof createRateLimiter>>();

	for (const t of webhookTriggers) {
		const rl = t.config.rateLimit ?? DEFAULT_RATE_LIMIT;
		pathRateLimiters.set(t.config.path, createRateLimiter(rl));
	}
	if (slackTriggers.length > 0) {
		const rl = slackTriggers.find((t) => t.config.rateLimit)?.config.rateLimit ?? DEFAULT_RATE_LIMIT;
		pathRateLimiters.set("/slack/events", createRateLimiter(rl));
	}

	// Mount all adapter routes as Elysia routes with per-trigger rate limiting
	const app = new Elysia({ name: "trigger-adapters" });

	// Collect all known paths for route registration.
	// Handlers are looked up at request time from the lazily-populated maps.
	const allPaths = new Set<string>();
	for (const t of webhookTriggers) allPaths.add(t.config.path);
	if (slackTriggers.length > 0) allPaths.add("/slack/events");

	for (const path of allPaths) {
		const limiter = pathRateLimiters.get(path) ?? createRateLimiter(DEFAULT_RATE_LIMIT);
		app.post(path, async ({ request, set }) => {
			if (!routesReady) {
				set.status = 503;
				return { error: "Trigger routes initializing" };
			}
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
			const allRoutes = { ...webhookRoutes, ...slackRoutes };
			const handler = allRoutes[path];
			if (!handler) {
				set.status = 404;
				return { error: "Route not found" };
			}
			return handler(request);
		});
	}

	// Graceful shutdown — registering a handler prevents the default
	// exit behaviour, so we must call process.exit() after cleanup.
	let shuttingDown = false;
	const shutdown = async () => {
		if (shuttingDown) return;
		shuttingDown = true;
		sessionManager.closeAll();
		cronAdapter.stop();
		telegramPollAdapter.stop();
		if (queueManager) {
			await queueManager.close();
		}
		await redis.quit();
		setTimeout(() => process.exit(0), 500);
	};
	process.on("SIGINT", shutdown);
	process.on("SIGTERM", shutdown);

	return app;
}
