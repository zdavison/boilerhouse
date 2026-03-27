export { Dispatcher, DispatchError, waitForReady } from "./dispatcher";
export type {
	DispatcherDeps,
	DispatcherOptions,
	DispatchResult,
	TriggerEvent,
	ClaimResult,
} from "./dispatcher";

export { SessionManager, SessionError } from "./session-manager";

export type { Driver, DriverEndpoint, DriverSocket, DriverConfig, DriverMap, SendContext } from "./driver";
export { resolveDriver, DriverResolveError } from "./resolve-driver";
export type { ResolvedDriver } from "./resolve-driver";

export type { Guard, GuardContext, GuardResult, GuardMap } from "./guard";
export { resolveGuard, GuardResolveError } from "./resolve-guard";
export { DriverSocketImpl, DriverSocketError } from "./driver-socket";

// Built-in drivers
export { defaultDriver } from "./drivers/default";

export { resolveTenantId, TenantResolutionError } from "./resolve-tenant";

export { createWebhookRoutes } from "./adapters/webhook";
export { createSlackRoutes } from "./adapters/slack";
export { createTelegramRoutes, registerTelegramWebhooks } from "./adapters/telegram";
export { TelegramPollAdapter } from "./adapters/telegram-poll";
export { CronAdapter } from "./adapters/cron";

export { TriggerQueueManager, QueuedDispatcher } from "./trigger-queue-manager";
export type { QueueJobData, TriggerQueueDepth } from "./trigger-queue-manager";

export { defineTrigger } from "./config";
export type {
	TriggerPayload,
	TenantMapping,
	TriggerDefinition,
	WebhookConfig,
	SlackConfig,
	TelegramConfig,
	TelegramPollConfig,
	CronConfig,
	RateLimitConfig,
} from "./config";
