import { Elysia, t } from "elysia";
import type { TenantId } from "@boilerhouse/core";
import type { RouteDeps } from "./deps";

const SAFE_SECRET_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const TENANT_ID_REGEX = "^[a-zA-Z0-9._@:-]{1,256}$";

export function secretRoutes(deps: RouteDeps) {
	const { secretStore } = deps;

	return new Elysia({ name: "secrets" })
		.put("/tenants/:id/secrets/:name", ({ params, body, set }) => {
			if (!SAFE_SECRET_NAME.test(params.name)) {
				set.status = 400;
				return { error: "Invalid secret name" };
			}

			const tenantId = params.id as TenantId;
			secretStore.set(tenantId, params.name, body.value);
			set.status = 201;
			return { stored: true };
		}, {
			params: t.Object({ id: t.String({ pattern: TENANT_ID_REGEX }), name: t.String() }),
			body: t.Object({
				value: t.String({ minLength: 1 }),
			}),
		})
		.get("/tenants/:id/secrets", ({ params }) => {
			const tenantId = params.id as TenantId;
			return { secrets: secretStore.list(tenantId) };
		}, {
			params: t.Object({ id: t.String({ pattern: TENANT_ID_REGEX }) }),
		})
		.delete("/tenants/:id/secrets/:name", ({ params }) => {
			const tenantId = params.id as TenantId;
			secretStore.delete(tenantId, params.name);
			return { deleted: true };
		}, {
			params: t.Object({ id: t.String({ pattern: TENANT_ID_REGEX }), name: t.String() }),
		});
}
