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
	guard: "@boilerhouse/guard-allowlist",
	guardOptions: {
		tenantIds: ["tg-thingsdoer"],
		denyMessage: "You are not authorised to use this service.",
	},
});
