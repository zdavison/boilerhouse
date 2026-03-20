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
} from "@boilerhouse/triggers";
import type {
	DispatcherDeps,
	TriggerDefinition,
	WebhookConfig,
	SlackConfig,
	TelegramConfig,
	CronConfig,
} from "@boilerhouse/triggers";

const port = Number(process.env.PORT ?? 3001);
const apiUrl = process.env.API_URL ?? "http://localhost:3000";
const configPath = process.env.TRIGGERS_CONFIG;

// ── Load trigger definitions ────────────────────────────────────────────────

async function loadTriggers(): Promise<TriggerDefinition[]> {
	if (!configPath) {
		console.error("TRIGGERS_CONFIG not set — no triggers will be loaded");
		return [];
	}

	const file = Bun.file(configPath);
	if (!(await file.exists())) {
		console.error(`Triggers config not found: ${configPath}`);
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
console.log(`Loaded ${triggers.length} trigger definition(s)`);

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
const webhookRoutes = createWebhookRoutes(webhookTriggers, dispatcher);
const slackRoutes = createSlackRoutes(slackTriggers, dispatcher);
const telegramRoutes = createTelegramRoutes(telegramTriggers, dispatcher);

// Start cron adapter
const cronAdapter = new CronAdapter();
if (cronTriggers.length > 0) {
	cronAdapter.start(cronTriggers, dispatcher);
	console.log(`Started ${cronTriggers.length} cron trigger(s)`);
}

// Register Telegram webhooks if public URL is set
const publicUrl = process.env.TRIGGERS_PUBLIC_URL;
if (telegramTriggers.length > 0 && publicUrl) {
	registerTelegramWebhooks(telegramTriggers, publicUrl).catch((err) => {
		console.error("Failed to register Telegram webhooks:", err);
	});
}

// Mount all adapter routes
const app = new Elysia()
	.get("/healthz", () => ({ status: "ok" }));

const allRoutes = { ...webhookRoutes, ...slackRoutes, ...telegramRoutes };
for (const [path, handler] of Object.entries(allRoutes)) {
	app.post(path, async ({ request }) => handler(request));
}

app.listen(port);
console.log(`🌐 Trigger gateway listening on port ${port}`);
console.log(`   Proxying claims to ${apiUrl}`);
console.log(`   Routes: ${Object.keys(allRoutes).join(", ") || "(none)"}`);

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
