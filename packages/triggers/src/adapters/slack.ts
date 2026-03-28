import type { TriggerDefinition, SlackConfig, TriggerPayload } from "../config";
import type { DriverMap } from "../driver";
import type { GuardMap } from "../guard";
import type { Dispatcher } from "../dispatcher";
import { DispatchError } from "../dispatcher";
import { resolveTenantId, TenantResolutionError } from "../resolve-tenant";

type SlackTrigger = TriggerDefinition & { config: SlackConfig };

/** Verify Slack request signature. */
async function verifySlackSignature(
	signingSecret: string,
	timestamp: string,
	body: string,
	signature: string,
): Promise<boolean> {
	const baseString = `v0:${timestamp}:${body}`;
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(signingSecret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(baseString));
	const expected = `v0=${Buffer.from(sig).toString("hex")}`;
	return expected === signature;
}

/** Post a message to a Slack channel. */
export async function postSlackMessage(
	botToken: string,
	channel: string,
	text: string,
): Promise<void> {
	await fetch("https://slack.com/api/chat.postMessage", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${botToken}`,
		},
		body: JSON.stringify({ channel, text }),
	});
}

/** Create route handlers for Slack triggers. Single /slack/events endpoint. */
export function createSlackRoutes(
	triggers: SlackTrigger[],
	dispatcher: Dispatcher,
	drivers?: DriverMap,
	guards?: GuardMap,
): Record<string, (req: Request) => Promise<Response>> {
	if (triggers.length === 0) return {};

	const routes: Record<string, (req: Request) => Promise<Response>> = {};

	routes["/slack/events"] = async (req: Request) => {
		if (req.method !== "POST") {
			return Response.json({ error: "Method not allowed" }, { status: 405 });
		}

		const rawBody = await req.text();
		let body: Record<string, unknown>;
		try {
			body = JSON.parse(rawBody) as Record<string, unknown>;
		} catch {
			return Response.json({ error: "Invalid JSON" }, { status: 400 });
		}

		// URL verification challenge
		if (body.type === "url_verification") {
			return Response.json({ challenge: body.challenge });
		}

		// Event callbacks
		if (body.type === "event_callback") {
			const event = body.event as Record<string, unknown> | undefined;
			if (!event) {
				return Response.json({ error: "Missing event" }, { status: 400 });
			}

			const eventType = event.type as string;

			// Find matching trigger by event type
			const trigger = triggers.find((t) =>
				t.config.eventTypes.includes(eventType),
			);
			if (!trigger) {
				// Event type not handled by any trigger
				return new Response(null, { status: 200 });
			}

			// Verify signature
			const timestamp = req.headers.get("X-Slack-Request-Timestamp");
			const signature = req.headers.get("X-Slack-Signature");
			if (!timestamp || !signature) {
				return Response.json({ error: "Missing signature headers" }, { status: 401 });
			}

			const valid = await verifySlackSignature(
				trigger.config.signingSecret,
				timestamp,
				rawBody,
				signature,
			);
			if (!valid) {
				return Response.json({ error: "Invalid signature" }, { status: 401 });
			}

			const channel = event.channel as string | undefined;
			const text = event.text as string | undefined;
			const user = event.user as string | undefined;

			// Resolve tenant from Slack event context
			let tenantId: string;
			try {
				tenantId = resolveTenantId(trigger.tenant, {
					user,
					channel,
					text,
					eventType,
					teamId: body.team_id,
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

				const payload: TriggerPayload = {
					text: text ?? "",
					source: "slack",
					raw: event,
				};

				await dispatcher.dispatch({
					triggerName: trigger.name,
					tenantId,
					workload: trigger.workload,
					payload,
					respond: async (message) => {
						if (channel) {
							const text = typeof message === "string" ? message : JSON.stringify(message);
							await postSlackMessage(trigger.config.botToken, channel, text);
						}
					},
					...(channel && {
						replyContext: {
							adapter: "slack" as const,
							channelId: channel,
						},
					}),
					...(resolved && {
						driver: resolved.driver,
						driverConfig: resolved.driverConfig,
					}),
					...(guard && {
						guard,
						triggerDef: trigger,
					}),
				});

				return new Response(null, { status: 200 });
			} catch (err) {
				if (err instanceof DispatchError) {
					return Response.json(
						{ error: err.message },
						{ status: err.statusCode },
					);
				}
				return Response.json({ error: "Internal error" }, { status: 500 });
			}
		}

		return new Response(null, { status: 200 });
	};

	return routes;
}
