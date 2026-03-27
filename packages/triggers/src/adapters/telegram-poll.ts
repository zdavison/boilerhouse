/**
 * Telegram polling adapter — uses getUpdates long-polling instead of webhooks.
 *
 * Inherently secure: no inbound endpoint to spoof, bot token over TLS is the
 * only credential. Follows the CronAdapter lifecycle pattern (start/stop).
 */

import type { TriggerDefinition, TelegramPollConfig } from "../config";
import type { DriverMap } from "../driver";
import type { GuardMap } from "../guard";
import type { Dispatcher } from "../dispatcher";
import { createLogger } from "@boilerhouse/o11y";
import { resolveTenantId, TenantResolutionError } from "../resolve-tenant";
import { parseTelegramUpdate, telegramUpdateToPayload } from "./telegram-parse";
import { sendTelegramMessage } from "./telegram";

const log = createLogger("telegram-poll");

type TelegramPollTrigger = TriggerDefinition & { config: TelegramPollConfig };

const DEFAULT_POLL_TIMEOUT = 30;
const ERROR_BACKOFF_MS = 5_000;

interface PollLoop {
	trigger: TelegramPollTrigger;
	abort: AbortController;
	offset: number;
}

export class TelegramPollAdapter {
	private loops: PollLoop[] = [];
	private running = false;

	start(
		triggers: TelegramPollTrigger[],
		dispatcher: Dispatcher,
		drivers?: DriverMap,
		guards?: GuardMap,
	): void {
		this.running = true;

		for (const trigger of triggers) {
			const { botToken } = trigger.config;
			if (!botToken) {
				log.error({ trigger: trigger.name }, "No botToken configured, skipping");
				continue;
			}

			const maskedToken = botToken.replace(/^(\d+:).{6}(.*)$/, "$1******$2").slice(0, 20) + "...";
			log.info({ trigger: trigger.name, botToken: maskedToken, workload: trigger.workload }, "Starting poll loop");

			const abort = new AbortController();
			const loop: PollLoop = { trigger, abort, offset: 0 };
			this.loops.push(loop);
			this.poll(loop, dispatcher, drivers, guards);
		}
	}

	stop(): void {
		this.running = false;
		for (const loop of this.loops) {
			loop.abort.abort();
		}
		this.loops = [];
	}

	private async poll(
		loop: PollLoop,
		dispatcher: Dispatcher,
		drivers?: DriverMap,
		guards?: GuardMap,
	): Promise<void> {
		const { trigger, abort } = loop;
		const { botToken, updateTypes = ["message"], pollTimeoutSeconds = DEFAULT_POLL_TIMEOUT, apiBaseUrl = "https://api.telegram.org" } = trigger.config;
		const allowedUpdates = JSON.stringify(updateTypes);
		const tgApi = `${apiBaseUrl}/bot${botToken}`;
		const resolved = drivers?.get(trigger.name);
		const guard = guards?.get(trigger.name);

		// Clear any existing webhook before starting to poll
		log.debug({ trigger: trigger.name }, "Clearing webhook");
		await this.deleteWebhook(tgApi);

		// Verify bot token by calling getMe
		try {
			const meRes = await fetch(`${tgApi}/getMe`);
			const me = await meRes.json() as { ok: boolean; result?: { username?: string; id?: number }; description?: string };
			if (me.ok && me.result) {
				log.info({ trigger: trigger.name, username: me.result.username, botId: me.result.id }, "Connected to Telegram");
			} else {
				log.error({ trigger: trigger.name, error: me.description ?? "unknown error" }, "getMe failed — check botToken");
				return;
			}
		} catch (err) {
			log.error({ trigger: trigger.name, err }, "getMe request failed");
			return;
		}

		log.info({ trigger: trigger.name, timeoutSeconds: pollTimeoutSeconds, updateTypes }, "Polling started");

		while (this.running && !abort.signal.aborted) {
			try {
				const url = `${tgApi}/getUpdates?timeout=${pollTimeoutSeconds}&offset=${loop.offset}&allowed_updates=${allowedUpdates}`;

				const res = await fetch(url, {
					signal: abort.signal,
					// Fetch timeout should exceed the long-poll timeout
					// so we don't abort a normal long-poll wait
				});

				if (!res.ok) {
					const body = await res.text().catch(() => "");
					log.error({ trigger: trigger.name, status: res.status, body }, "getUpdates HTTP error");
					await this.backoff(abort.signal);
					continue;
				}

				const json = await res.json() as {
					ok: boolean;
					result?: Array<Record<string, unknown>>;
					description?: string;
				};

				if (!json.ok || !json.result) {
					log.error({ trigger: trigger.name, error: json.description ?? "unknown" }, "getUpdates error");
					await this.backoff(abort.signal);
					continue;
				}

				if (json.result.length > 0) {
					log.info({ trigger: trigger.name, count: json.result.length }, "Received updates");
				}

				for (const update of json.result) {
					const updateId = update.update_id as number;

					// Advance offset to acknowledge this update
					if (updateId >= loop.offset) {
						loop.offset = updateId + 1;
					}

					const parsed = parseTelegramUpdate(update);
					if (!parsed || !updateTypes.includes(parsed.updateType)) {
						continue;
					}

					// Resolve tenant
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
							log.error({ trigger: trigger.name, err }, "Tenant resolution failed");
						}
						continue;
					}

					// Dispatch
					try {
						const payload = telegramUpdateToPayload(parsed, update);
						const result = await dispatcher.dispatch({
							triggerName: trigger.name,
							tenantId,
							workload: trigger.workload,
							payload,
							respond: async (message) => {
								if (parsed.chatId) {
									const text = typeof message === "string" ? message : JSON.stringify(message);
									await sendTelegramMessage(botToken, parsed.chatId, text, apiBaseUrl)
										.catch((sendErr) => log.error({ trigger: trigger.name, chatId: parsed.chatId, err: sendErr }, "Failed to send guard response"));
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
							await sendTelegramMessage(botToken, parsed.chatId, responseText, apiBaseUrl)
							.catch((sendErr) => log.error({ trigger: trigger.name, chatId: parsed.chatId, err: sendErr }, "Failed to send Telegram response"));
						}
					} catch (err) {
						log.error({ trigger: trigger.name, err }, "Dispatch failed");
					}
				}
			} catch (err) {
				// AbortError is expected on shutdown
				if (abort.signal.aborted) break;

				log.error({ trigger: trigger.name, err }, "Poll error");
				await this.backoff(abort.signal);
			}
		}
	}

	private async deleteWebhook(tgApi: string): Promise<void> {
		try {
			const res = await fetch(
				`${tgApi}/deleteWebhook`,
				{ method: "POST" },
			);
			const json = await res.json() as { ok: boolean; description?: string };
			if (!json.ok) {
				log.error({ error: json.description }, "deleteWebhook failed");
			}
		} catch (err) {
			log.error({ err }, "deleteWebhook error");
		}
	}

	private async backoff(signal: AbortSignal): Promise<void> {
		if (signal.aborted) return;
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, ERROR_BACKOFF_MS);
			signal.addEventListener("abort", () => {
				clearTimeout(timer);
				resolve();
			}, { once: true });
		});
	}
}
