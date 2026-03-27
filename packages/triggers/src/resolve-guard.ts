/**
 * Resolves a guard string (package name or path) to a Guard instance.
 * Called once at startup per trigger that declares a guard.
 */

import { resolve, dirname } from "node:path";
import type { Guard } from "./guard";

/**
 * Resolve a guard from a trigger definition.
 *
 * @param guardSpec  Package name, path, or undefined (returns null)
 *
 * @example
 * // Package name — imports the default export
 * await resolveGuard("@boilerhouse/guard-allowlist")
 *
 * // Relative path
 * await resolveGuard("./guards/my-guard.ts")
 *
 * // No guard — returns null
 * await resolveGuard(undefined)
 */
export async function resolveGuard(
	guardSpec: string | undefined,
): Promise<Guard | null> {
	if (!guardSpec) {
		return null;
	}

	let importPath = guardSpec;
	if (guardSpec.startsWith("@boilerhouse/")) {
		const pkgName = guardSpec.replace("@boilerhouse/", "");
		const thisFile = import.meta.url.replace("file://", "");
		const monorepoRoot = resolve(dirname(thisFile), "../../..");
		importPath = resolve(monorepoRoot, "packages", pkgName, "src/index.ts");
	}

	let mod: Record<string, unknown>;
	try {
		mod = await import(importPath) as Record<string, unknown>;
	} catch (err) {
		throw new GuardResolveError(
			`Failed to import guard "${guardSpec}" (resolved to "${importPath}"): ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	const guard = findGuard(mod);
	if (!guard) {
		throw new GuardResolveError(
			`Guard "${guardSpec}" does not export a valid Guard (must have a check() method)`,
		);
	}

	return guard;
}

function findGuard(mod: Record<string, unknown>): Guard | null {
	// Prefer default export
	const defaultExport = mod.default as Record<string, unknown> | undefined;
	if (defaultExport && typeof defaultExport.check === "function") {
		return defaultExport as unknown as Guard;
	}

	// Fall back to first named export that looks like a Guard
	for (const value of Object.values(mod)) {
		if (value && typeof value === "object" && typeof (value as Record<string, unknown>).check === "function") {
			return value as unknown as Guard;
		}
	}

	return null;
}

export class GuardResolveError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "GuardResolveError";
	}
}
