import { Elysia, t } from "elysia";
import type { TenantId } from "@boilerhouse/core";
import type { RouteDeps } from "./deps";

const SAFE_SECRET_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export function secretRoutes(deps: RouteDeps) {
	const { secretStore } = deps;

	return new Elysia({ name: "secrets" })
		.put("/tenants/:id/secrets/:name", ({ params, body, set }) => {
			if (!secretStore) {
				set.status = 501;
				return { error: "Secret store not configured" };
			}

			if (!SAFE_SECRET_NAME.test(params.name)) {
				set.status = 400;
				return { error: "Invalid secret name" };
			}

			const tenantId = params.id as TenantId;
			secretStore.set(tenantId, params.name, body.value);
			set.status = 201;
			return { stored: true };
		}, {
			body: t.Object({
				value: t.String({ minLength: 1 }),
			}),
		})
		.get("/tenants/:id/secrets", ({ params, set }) => {
			if (!secretStore) {
				set.status = 501;
				return { error: "Secret store not configured" };
			}

			const tenantId = params.id as TenantId;
			return { secrets: secretStore.list(tenantId) };
		})
		.delete("/tenants/:id/secrets/:name", ({ params, set }) => {
			if (!secretStore) {
				set.status = 501;
				return { error: "Secret store not configured" };
			}

			const tenantId = params.id as TenantId;
			secretStore.delete(tenantId, params.name);
			return { deleted: true };
		});
}
