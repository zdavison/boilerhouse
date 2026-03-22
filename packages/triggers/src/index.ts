export { Dispatcher, DispatchError, waitForReady } from "./dispatcher";
export type {
	DispatcherDeps,
	DispatcherOptions,
	DispatchResult,
	TriggerEvent,
	ClaimResult,
} from "./dispatcher";

export { SessionManager, SessionError } from "./session-manager";

export { resolveTenantId, TenantResolutionError } from "./resolve-tenant";

export { createWebhookRoutes } from "./adapters/webhook";
export { createSlackRoutes } from "./adapters/slack";
export { createTelegramRoutes, registerTelegramWebhooks } from "./adapters/telegram";
export { CronAdapter } from "./adapters/cron";

export type {
	TenantMapping,
	TriggerDefinition,
	WebhookConfig,
	SlackConfig,
	TelegramConfig,
	CronConfig,
	RateLimitConfig,
} from "./config";
