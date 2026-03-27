/**
 * Trigger Gateway — public-facing process for webhook/Slack/Telegram ingress.
 *
 * This process has NO access to the database, runtime, or secrets.
 * It validates incoming webhook signatures, resolves tenant IDs, and
 * proxies claims to the internal API over HTTP.
 *
 * Environment variables:
 *   PORT              — listen port (default 3001)
 *   API_URL           — internal API base URL (default http://localhost:3000)
 *   TRIGGERS_CONFIG   — path to triggers JSON config file
 *   TRIGGERS_PUBLIC_URL — public URL for registering Telegram webhooks
 */
import { Elysia } from "elysia";
import {
	Dispatcher,
	SessionManager,
	CronAdapter,
	createWebhookRoutes,
	createSlackRoutes,
	createTelegramRoutes,
	registerTelegramWebhooks,
	resolveGuard,
} from "@boilerhouse/triggers";
import type {
	DispatcherDeps,
	TriggerDefinition,
	WebhookConfig,
	SlackConfig,
	TelegramConfig,
	CronConfig,
	GuardMap,
} from "@boilerhouse/triggers";
import { createLogger } from "@boilerhouse/o11y";

const log = createLogger("trigger-gateway");

const port = Number(process.env.PORT ?? 3002);
const apiUrl = process.env.API_URL ?? "http://localhost:3000";
const configPath = process.env.TRIGGERS_CONFIG;

// ── Load trigger definitions ────────────────────────────────────────────────

async function loadTriggers(): Promise<TriggerDefinition[]> {
	if (!configPath) {
		log.warn("TRIGGERS_CONFIG not set — no triggers will be loaded");
		return [];
	}

	const file = Bun.file(configPath);
	if (!(await file.exists())) {
		log.error({ configPath }, "Triggers config not found");
		return [];
	}

	const raw = await file.json();
	if (!Array.isArray(raw)) {
		throw new Error("TRIGGERS_CONFIG must be a JSON array of trigger definitions");
	}

	return raw as TriggerDefinition[];
}

// ── Dispatcher deps: claim via internal API ─────────────────────────────────

function createHttpDispatcherDeps(): DispatcherDeps {
	return {
		async claim(tenantId: string, workloadName: string) {
			const res = await fetch(`${apiUrl}/api/v1/tenants/${encodeURIComponent(tenantId)}/claim`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ workload: workloadName }),
			});

			if (!res.ok) {
				const body = await res.json().catch(() => ({ error: "Unknown error" }));
				throw new Error(
					`Claim failed (${res.status}): ${(body as Record<string, string>).error ?? JSON.stringify(body)}`,
				);
			}

			return res.json();
		},

		logActivity(entry) {
			// Fire-and-forget: POST to internal API activity endpoint
			fetch(`${apiUrl}/api/v1/activity`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(entry),
			}).catch(() => {});
		},
	};
}

// ── Build and start server ──────────────────────────────────────────────────

const triggers = await loadTriggers();
log.info({ count: triggers.length }, "Loaded trigger definitions");

// ── Resolve guards at startup ────────────────────────────────────────────────

const guardMap: GuardMap = new Map();
for (const trigger of triggers) {
	// Cron triggers skip guards (no user to deny)
	if (trigger.type === "cron" || !trigger.guard) continue;
	try {
		const guard = await resolveGuard(trigger.guard);
		if (guard) {
			guardMap.set(trigger.name, guard);
			log.info({ trigger: trigger.name, guard: trigger.guard }, "Resolved guard");
		}
	} catch (err) {
		log.error({ trigger: trigger.name, guard: trigger.guard, err }, "Failed to resolve guard");
		process.exit(1);
	}
}

const dispatcherDeps = createHttpDispatcherDeps();
const sessionManager = new SessionManager();
const dispatcher = new Dispatcher(dispatcherDeps, { sessionManager });

// Group by type
const webhookTriggers = triggers.filter(
	(t): t is TriggerDefinition & { config: WebhookConfig } => t.type === "webhook",
);
const slackTriggers = triggers.filter(
	(t): t is TriggerDefinition & { config: SlackConfig } => t.type === "slack",
);
const telegramTriggers = triggers.filter(
	(t): t is TriggerDefinition & { config: TelegramConfig } => t.type === "telegram",
);
const cronTriggers = triggers.filter(
	(t): t is TriggerDefinition & { config: CronConfig } => t.type === "cron",
);

// Build adapter routes
const webhookRoutes = createWebhookRoutes(webhookTriggers, dispatcher, undefined, guardMap);
const slackRoutes = createSlackRoutes(slackTriggers, dispatcher, undefined, guardMap);
const telegramRoutes = createTelegramRoutes(telegramTriggers, dispatcher, undefined, guardMap);

// Start cron adapter
const cronAdapter = new CronAdapter();
if (cronTriggers.length > 0) {
	cronAdapter.start(cronTriggers, dispatcher);
	log.info({ count: cronTriggers.length }, "Started cron triggers");
}

// Register Telegram webhooks if public URL is set
const publicUrl = process.env.TRIGGERS_PUBLIC_URL;
if (telegramTriggers.length > 0 && publicUrl) {
	registerTelegramWebhooks(telegramTriggers, publicUrl).catch((err) => {
		log.error({ err }, "Failed to register Telegram webhooks");
	});
}

// Mount all adapter routes
const app = new Elysia()
	.get("/healthz", () => ({ status: "ok" }));

const allRoutes = { ...webhookRoutes, ...slackRoutes, ...telegramRoutes };
for (const [path, handler] of Object.entries(allRoutes)) {
	app.post(path, async ({ request }) => handler(request));
}

app.listen({ port, hostname: process.env.LISTEN_HOST ?? "127.0.0.1" });
log.info({ port, apiUrl, routes: Object.keys(allRoutes) }, "Trigger gateway listening");

// Graceful shutdown
process.on("SIGINT", () => {
	sessionManager.closeAll();
	cronAdapter.stop();
	process.exit(0);
});
process.on("SIGTERM", () => {
	sessionManager.closeAll();
	cronAdapter.stop();
	process.exit(0);
});
