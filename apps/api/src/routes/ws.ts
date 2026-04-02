import { Elysia } from "elysia";
import type { RouteDeps } from "./deps";
import type { DomainEvent } from "@boilerhouse/domain";

export function wsPlugin(deps: RouteDeps) {
	const { eventBus, apiKey } = deps;

	return new Elysia({ name: "ws" })
		.guard({
			beforeHandle({ request, set }) {
				if (!apiKey) return;
				const url = new URL(request.url);
				const token = url.searchParams.get("token");
				if (token !== apiKey) {
					set.status = 401;
					return { error: "Unauthorized" };
				}
			},
		})
		.ws("/ws", {
			open(ws) {
				const handler = (event: DomainEvent) => {
					ws.send(JSON.stringify(event));
				};
				eventBus.on(handler);
				// Store handler reference for cleanup
				(ws.data as Record<string, unknown>).__handler = handler;
			},
			message(_ws, _message) {
				// Client-to-server messages are ignored
			},
			close(ws) {
				const handler = (ws.data as Record<string, unknown>).__handler as
					| ((event: DomainEvent) => void)
					| undefined;
				if (handler) {
					eventBus.off(handler);
				}
			},
		});
}
