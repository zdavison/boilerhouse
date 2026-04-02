import { defineTrigger } from "@boilerhouse/triggers";

export default defineTrigger({
	name: "tg-claude-code",
	type: "telegram-poll",
	workload: "claude-code",
	tenant: { fromField: "usernameOrId", prefix: "tg-" },
	config: {
		botToken: process.env.TELEGRAM_BOT_TOKEN_CC ?? "",
		updateTypes: ["message"],
		pollTimeoutSeconds: 30,
	},
	driver: "@boilerhouse/driver-claude-code",
	driverOptions: {},
	guards: [
		{
			guard: "@boilerhouse/guard-allowlist",
			guardOptions: {
				tenantIds: (process.env.ALLOWLIST_TENANT_IDS ?? "").split(",").filter(Boolean),
				denyMessage: "You are not authorised to use this service.",
			},
		},
	],
});
