// Trigger configuration types

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
	type: "webhook" | "slack" | "telegram" | "cron";

	/** How to resolve the tenant ID from each event. */
	tenant: TenantMapping;

	/** Workload name to claim. Must exist in boilerhouse. */
	workload: string;

	/** Adapter-specific configuration. */
	config: WebhookConfig | SlackConfig | TelegramConfig | CronConfig;
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

export interface TelegramConfig {
	/** Telegram bot token from @BotFather.
	 * @example "123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
	 */
	botToken: string;

	/** Webhook secret token for verifying incoming updates.
	 * Telegram sends this in the X-Telegram-Bot-Api-Secret-Token header.
	 */
	secretToken?: string;

	/** Message types to handle.
	 * @default ["message"]
	 * @example ["message", "callback_query"]
	 */
	updateTypes?: string[];

	/** Rate limit for this trigger's endpoint. */
	rateLimit?: RateLimitConfig;
}

export interface CronConfig {
	// Cron expression (5-field standard), e.g. "0 * * * *" or every-5-min syntax.
	// @example "0 * * * *"
	schedule: string;

	/** Static payload to forward when the cron fires. */
	payload?: Record<string, unknown>;
}
