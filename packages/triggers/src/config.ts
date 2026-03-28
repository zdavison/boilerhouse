// Trigger configuration types

/**
 * Normalized payload shape produced by all trigger adapters.
 * Drivers receive this consistent shape regardless of whether the
 * event came from Telegram, Slack, a webhook, or a cron job.
 */
export interface TriggerPayload {
	/** The message text. Empty string for non-text events. */
	text: string;
	/** Which adapter produced this event. */
	source: "telegram" | "slack" | "webhook" | "cron";
	/** Raw adapter-specific event data. */
	raw: unknown;
}

/** How to determine the tenant ID for a trigger event. */
export type TenantMapping =
	| {
			/** Fixed tenant ID — every event uses this tenant.
			 * @example "reporting-bot"
			 */
			static: string;
	  }
	| {
			/** Dot-path into the adapter's event context to extract the tenant value.
			 * @example "user" (Slack user ID)
			 * @example "chatId" (Telegram chat ID)
			 * @example "body.tenantId" (webhook body field)
			 */
			fromField: string;
			/** Prefix prepended to the extracted value.
			 * @example "slack-" → tenant "slack-U12345"
			 */
			prefix?: string;
	  };

export interface TriggerDefinition {
	/** Unique name for this trigger.
	 * @example "slack-support-agent"
	 */
	name: string;

	/** Adapter type. */
	type: "webhook" | "slack" | "telegram-poll" | "cron";

	/** How to resolve the tenant ID from each event. */
	tenant: TenantMapping;

	/** Workload name to claim. Must exist in boilerhouse. */
	workload: string;

	/** Adapter-specific configuration. */
	config: WebhookConfig | SlackConfig | TelegramPollConfig | CronConfig;

	/**
	 * Driver for WebSocket protocol translation.
	 * When set, the trigger layer uses this driver to communicate
	 * with the claimed container over WebSocket instead of raw JSON.
	 *
	 * Can be a package name (resolved via import) or a Driver instance.
	 * @example "@boilerhouse/driver-openclaw"
	 */
	driver?: string;

	/** Driver-specific options (authentication, timeouts, etc). */
	driverOptions?: Record<string, unknown>;

	/**
	 * Guard for access control. Runs before the container is claimed.
	 * Can be a package name or relative file path.
	 * @example "@boilerhouse/guard-api"
	 */
	guard?: string;

	/** Guard-specific options passed to guard.check() as ctx.options. */
	guardOptions?: Record<string, unknown>;
}

export interface RateLimitConfig {
	/** Maximum requests per window. @default 60 */
	max: number;
	/** Window size in milliseconds. @default 60_000 */
	windowMs?: number;
}

export interface WebhookConfig {
	/** URL path to listen on.
	 * @example "/hooks/deploy-agent"
	 */
	path: string;

	/** HMAC secret for signature verification (SHA-256).
	 * If set, requests must include X-Signature-256 header.
	 */
	secret?: string;

	/** Rate limit for this trigger's endpoint. */
	rateLimit?: RateLimitConfig;
}

export interface SlackConfig {
	/** Slack app signing secret for request verification. */
	signingSecret: string;

	/** Slack event types to handle.
	 * @example ["message", "app_mention"]
	 */
	eventTypes: string[];

	/** Slack bot token for sending responses.
	 * @example "xoxb-..."
	 */
	botToken: string;

	/** Rate limit for this trigger's endpoint. */
	rateLimit?: RateLimitConfig;
}

export interface TelegramPollConfig {
	/** Telegram bot token from @BotFather.
	 * @example "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
	 */
	botToken: string;

	/** Message types to handle.
	 * @default ["message"]
	 * @example ["message", "callback_query"]
	 */
	updateTypes?: string[];

	/** Long-poll timeout in seconds. Telegram holds the connection open for this long.
	 * @default 30
	 */
	pollTimeoutSeconds?: number;

	/** Override the Telegram API base URL. Used for testing with a mock server.
	 * @default "https://api.telegram.org"
	 */
	apiBaseUrl?: string;
}

export interface CronConfig {
	// Cron expression (5-field standard), e.g. "0 * * * *" or every-5-min syntax.
	// @example "0 * * * *"
	schedule: string;

	/** Static payload to forward when the cron fires. */
	payload?: Record<string, unknown>;
}

/**
 * Identity function that provides type checking for trigger definition files.
 * @example
 * ```ts
 * export default defineTrigger({
 *   name: "tg-support",
 *   type: "telegram-poll",
 *   workload: "support-agent",
 *   ...
 * });
 * ```
 */
export function defineTrigger(config: TriggerDefinition): TriggerDefinition {
	return config;
}
