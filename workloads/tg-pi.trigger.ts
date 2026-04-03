import { defineTrigger } from "@boilerhouse/triggers";

export default defineTrigger({
	name: "tg-pi",
	type: "telegram-poll",
	workload: "pi",
	tenant: { fromField: "usernameOrId", prefix: "tg-" },
	config: {
		botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
		updateTypes: ["message"],
		pollTimeoutSeconds: 30,
	},
	driver: "@boilerhouse/driver-pi",
	guards: [
		{
			guard: "@boilerhouse/guard-allowlist",
			guardOptions: {
				tenantIds: (process.env.BOILERHOUSE_ALLOWLIST_TENANT_IDS ?? "").split(",").filter(Boolean),
				denyMessage: "You are not authorised to use this service.",
			},
		},
	],
});
