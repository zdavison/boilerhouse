import { defineTrigger } from "@boilerhouse/triggers";

export default defineTrigger({
	name: "tg-claude-code",
	type: "telegram-poll",
	workload: "claude-code",
	tenant: { fromField: "chatId", prefix: "tg-" },
	config: {
		botToken: process.env.TELEGRAM_BOT_TOKEN_CC ?? "",
		updateTypes: ["message"],
		pollTimeoutSeconds: 30,
	},
	driver: "@boilerhouse/driver-claude-code",
	driverOptions: {},
});
