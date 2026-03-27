import type { TriggerDefinition, WebhookConfig, TriggerPayload } from "../config";
import type { DriverMap } from "../driver";
import type { GuardMap } from "../guard";
import type { Dispatcher } from "../dispatcher";
import { DispatchError } from "../dispatcher";
import { resolveTenantId, TenantResolutionError } from "../resolve-tenant";

type WebhookTrigger = TriggerDefinition & { config: WebhookConfig };

/** Verify HMAC-SHA256 signature of request body. */
async function verifyHmac(secret: string, body: string, signature: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
	const expected = `sha256=${Buffer.from(sig).toString("hex")}`;
	return expected === signature;
}

/** Create route handlers for webhook triggers. */
export function createWebhookRoutes(
	triggers: WebhookTrigger[],
	dispatcher: Dispatcher,
	drivers?: DriverMap,
	guards?: GuardMap,
): Record<string, (req: Request) => Promise<Response>> {
	const routes: Record<string, (req: Request) => Promise<Response>> = {};

	for (const trigger of triggers) {
		const { path, secret } = trigger.config;

		routes[path] = async (req: Request) => {
			if (req.method !== "POST") {
				return Response.json({ error: "Method not allowed" }, { status: 405 });
			}

			const rawBody = await req.text();

			// HMAC validation if secret is configured
			if (secret) {
				const signature = req.headers.get("X-Signature-256");
				if (!signature) {
					return Response.json({ error: "Missing signature" }, { status: 401 });
				}
				const valid = await verifyHmac(secret, rawBody, signature);
				if (!valid) {
					return Response.json({ error: "Invalid signature" }, { status: 401 });
				}
			}

			let payload: Record<string, unknown>;
			try {
				payload = JSON.parse(rawBody) as Record<string, unknown>;
			} catch {
				return Response.json({ error: "Invalid JSON body" }, { status: 400 });
			}

			// Resolve tenant from the request body
			let tenantId: string;
			try {
				tenantId = resolveTenantId(trigger.tenant, {
					body: payload,
					...payload,
					headers: Object.fromEntries(req.headers.entries()),
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

				const triggerPayload: TriggerPayload = {
					text: typeof payload.text === "string" ? payload.text : "",
					senderId: typeof payload.senderId === "string" ? payload.senderId : "",
					channelId: typeof payload.channelId === "string" ? payload.channelId : "",
					source: "webhook",
					raw: payload,
				};

				const result = await dispatcher.dispatch({
					triggerName: trigger.name,
					tenantId,
					workload: trigger.workload,
					payload: triggerPayload,
					...(resolved && {
						driver: resolved.driver,
						driverConfig: resolved.driverConfig,
					}),
					...(guard && {
						guard,
						triggerDef: trigger,
					}),
				});
				return Response.json(result.agentResponse);
			} catch (err) {
				if (err instanceof DispatchError) {
					return Response.json(
						{ error: err.message, body: err.body },
						{ status: err.statusCode },
					);
				}
				return Response.json({ error: "Internal error" }, { status: 500 });
			}
		};
	}

	return routes;
}
