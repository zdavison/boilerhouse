/**
 * Shared Telegram update parsing — used by both the webhook adapter
 * and the polling adapter.
 */

import type { TriggerPayload } from "../config";

/** Parsed fields from a Telegram Update object. */
export interface ParsedTelegramUpdate {
	updateType: "message" | "callback_query" | "edited_message";
	updateId: number;
	chatId: number | undefined;
	userId: number | undefined;
	text: string | undefined;
	senderName: string | undefined;
}

/**
 * Parse a raw Telegram Update object into structured fields.
 * Returns null if the update type is unrecognized.
 */
export function parseTelegramUpdate(
	update: Record<string, unknown>,
): ParsedTelegramUpdate | null {
	const updateId = update.update_id as number;

	const updateType = update.message
		? "message"
		: update.callback_query
			? "callback_query"
			: update.edited_message
				? "edited_message"
				: null;

	if (!updateType) return null;

	const message = (update.message ?? update.edited_message) as
		| { text?: string; chat?: { id: number }; from?: { id: number; first_name?: string; last_name?: string; username?: string } }
		| undefined;
	const callbackQuery = update.callback_query as
		| { data?: string; from?: { id: number; first_name?: string; last_name?: string; username?: string }; message?: { chat?: { id: number } } }
		| undefined;

	const chatId = message?.chat?.id ?? callbackQuery?.message?.chat?.id;
	const userId = message?.from?.id ?? callbackQuery?.from?.id;
	const text = message?.text ?? callbackQuery?.data;

	const from = message?.from ?? callbackQuery?.from;
	const senderName = from
		? [from.first_name, from.last_name].filter(Boolean).join(" ") || from.username
		: undefined;

	return { updateType, updateId, chatId, userId, text, senderName };
}

/**
 * Convert a parsed Telegram update into a normalized TriggerPayload.
 */
export function telegramUpdateToPayload(
	parsed: ParsedTelegramUpdate,
	raw: unknown,
): TriggerPayload {
	return {
		text: parsed.text ?? "",
		senderId: String(parsed.userId ?? ""),
		senderName: parsed.senderName,
		channelId: String(parsed.chatId ?? ""),
		source: "telegram",
		raw,
	};
}
