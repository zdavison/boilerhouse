import type { TenantMapping } from "./config";

/**
 * Resolve a tenant ID from a mapping and an event context.
 *
 * @param mapping - Static or field-based tenant mapping from trigger config
 * @param context - Flat or nested object built by the adapter from the incoming event
 * @returns Resolved tenant ID string
 * @throws If the field path doesn't resolve to a value
 */
export function resolveTenantId(
	mapping: TenantMapping,
	context: Record<string, unknown>,
): string {
	if ("static" in mapping) {
		return mapping.static;
	}

	const raw = getByPath(context, mapping.fromField);
	if (raw === undefined || raw === null) {
		throw new TenantResolutionError(
			`Field "${mapping.fromField}" not found in event context`,
		);
	}

	const value = String(raw);
	return mapping.prefix ? `${mapping.prefix}${value}` : value;
}

/** Traverse a dot-separated path into a nested object. */
function getByPath(obj: Record<string, unknown>, path: string): unknown {
	let current: unknown = obj;
	for (const key of path.split(".")) {
		if (current === null || current === undefined || typeof current !== "object") {
			return undefined;
		}
		current = (current as Record<string, unknown>)[key];
	}
	return current;
}

export class TenantResolutionError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TenantResolutionError";
	}
}
