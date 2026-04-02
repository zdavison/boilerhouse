import { defineTrigger } from "@boilerhouse/triggers";
import { GATEWAY_TOKEN } from "./openclaw.workload";

export default defineTrigger({
	name: "tg-openclaw",
	type: "telegram-poll",
	workload: "openclaw",
	tenant: { fromField: "usernameOrId", prefix: "tg-" },
	config: {
		botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
		updateTypes: ["message"],
		pollTimeoutSeconds: 30,
	},
	driver: "@boilerhouse/driver-openclaw",
	driverOptions: {
		gatewayToken: GATEWAY_TOKEN,
	},
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
