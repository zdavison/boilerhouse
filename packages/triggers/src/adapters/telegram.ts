import type { TriggerDefinition, TelegramConfig } from "../config";
import type { DriverMap } from "../driver";
import type { GuardMap } from "../guard";
import type { Dispatcher } from "../dispatcher";
import { DispatchError } from "../dispatcher";
import { resolveTenantId, TenantResolutionError } from "../resolve-tenant";
import { parseTelegramUpdate, telegramUpdateToPayload } from "./telegram-parse";
import { createLogger } from "@boilerhouse/o11y";

const log = createLogger("telegram");

type TelegramTrigger = TriggerDefinition & { config: TelegramConfig };

/** Send a message via the Telegram Bot API. */
export async function sendTelegramMessage(
	botToken: string,
	chatId: number,
	text: string,
	apiBaseUrl = "https://api.telegram.org",
): Promise<void> {
	await fetch(
		`${apiBaseUrl}/bot${botToken}/sendMessage`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ chat_id: chatId, text }),
		},
	);
}

/** Register webhook URLs with the Telegram Bot API. */
export async function registerTelegramWebhooks(
	triggers: TelegramTrigger[],
	baseUrl: string,
): Promise<void> {
	for (const trigger of triggers) {
		await fetch(
			`https://api.telegram.org/bot${trigger.config.botToken}/setWebhook`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					url: `${baseUrl}/telegram/${trigger.name}`,
					secret_token: trigger.config.secretToken,
					allowed_updates: trigger.config.updateTypes ?? ["message"],
				}),
			},
		);
	}
}

/** Create route handlers for Telegram triggers. One endpoint per trigger. */
export function createTelegramRoutes(
	triggers: TelegramTrigger[],
	dispatcher: Dispatcher,
	drivers?: DriverMap,
	guards?: GuardMap,
): Record<string, (req: Request) => Promise<Response>> {
	const routes: Record<string, (req: Request) => Promise<Response>> = {};

	for (const trigger of triggers) {
		const path = `/telegram/${trigger.name}`;
		const { secretToken, updateTypes = ["message"] } = trigger.config;

		routes[path] = async (req: Request) => {
			if (req.method !== "POST") {
				return Response.json({ error: "Method not allowed" }, { status: 405 });
			}

			// Verify secret token
			if (secretToken) {
				const headerToken = req.headers.get("X-Telegram-Bot-Api-Secret-Token");
				if (headerToken !== secretToken) {
					return Response.json({ error: "Invalid secret token" }, { status: 401 });
				}
			}

			let update: Record<string, unknown>;
			try {
				update = await req.json() as Record<string, unknown>;
			} catch {
				return Response.json({ error: "Invalid JSON" }, { status: 400 });
			}

			const parsed = parseTelegramUpdate(update);
			if (!parsed || !updateTypes.includes(parsed.updateType)) {
				return new Response(null, { status: 200 });
			}

			// Resolve tenant from Telegram event context
			let tenantId: string;
			try {
				tenantId = resolveTenantId(trigger.tenant, {
					chatId: parsed.chatId,
					userId: parsed.userId,
					text: parsed.text,
					updateType: parsed.updateType,
				});
			} catch (err) {
				if (err instanceof TenantResolutionError) {
					return Response.json({ error: err.message }, { status: 400 });
				}
				throw err;
			}

			try {
				const resolved = drivers?.get(trigger.name);
				const guard = guards?.get(trigger.name);
				const payload = telegramUpdateToPayload(parsed, update);

				const result = await dispatcher.dispatch({
					triggerName: trigger.name,
					tenantId,
					workload: trigger.workload,
					payload,
					respond: async (message) => {
						if (parsed.chatId) {
							const text = typeof message === "string" ? message : JSON.stringify(message);
							await sendTelegramMessage(trigger.config.botToken, parsed.chatId, text);
						}
					},
					...(resolved && {
						driver: resolved.driver,
						driverConfig: resolved.driverConfig,
					}),
					...(guard && {
						guard,
						triggerDef: trigger,
					}),
				});

				// Send response back to chat
				if (parsed.chatId && result.agentResponse) {
					const responseText =
						typeof result.agentResponse === "string"
							? result.agentResponse
							: (result.agentResponse as Record<string, unknown>).text as string ??
								JSON.stringify(result.agentResponse);
					await sendTelegramMessage(trigger.config.botToken, parsed.chatId, responseText);
				}

				return new Response(null, { status: 200 });
			} catch (err) {
				if (err instanceof DispatchError) {
					return Response.json(
						{ error: err.message },
						{ status: err.statusCode },
					);
				}
				log.error({ trigger: trigger.name, err }, "Telegram adapter error");
				return Response.json({ error: "Internal error" }, { status: 500 });
			}
		};
	}

	return routes;
}
