/**
 * Resolves a driver string (package name or path) to a Driver instance.
 * Called once at startup per trigger that declares a driver.
 */

import { resolve, dirname } from "node:path";
import type { Driver } from "./driver";
import { defaultDriver } from "./drivers/default";

/**
 * Resolved driver ready to be passed into dispatch calls.
 * Pre-resolved at startup so imports happen once, not per-request.
 */
export interface ResolvedDriver {
	driver: Driver;
	options: Record<string, unknown>;
}

/**
 * Resolve a driver from a trigger definition.
 *
 * @param driverSpec  Package name, path, or undefined (uses default)
 * @param options     Driver options from trigger config
 *
 * @example
 * // Package name — imports the default export
 * await resolveDriver("@boilerhouse/driver-openclaw", { gatewayToken: "..." })
 *
 * // Relative path
 * await resolveDriver("./drivers/my-driver.ts")
 *
 * // No driver — returns default
 * await resolveDriver(undefined)
 */
export async function resolveDriver(
	driverSpec: string | undefined,
	options?: Record<string, unknown>,
): Promise<ResolvedDriver> {
	if (!driverSpec) {
		return {
			driver: defaultDriver,
			options: options ?? {},
		};
	}

	// Resolve the import path. Workspace packages aren't in node_modules
	// with Bun, so we resolve @boilerhouse/* to their source paths.
	let importPath = driverSpec;
	if (driverSpec.startsWith("@boilerhouse/")) {
		const pkgName = driverSpec.replace("@boilerhouse/", "");
		const thisFile = import.meta.url.replace("file://", "");
		const monorepoRoot = resolve(dirname(thisFile), "../../..");
		importPath = resolve(monorepoRoot, "packages", pkgName, "src/index.ts");
	}

	let mod: Record<string, unknown>;
	try {
		mod = await import(importPath) as Record<string, unknown>;
	} catch (err) {
		throw new DriverResolveError(
			`Failed to import driver "${driverSpec}" (resolved to "${importPath}"): ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	// Look for a Driver-shaped export: default > first export with send()
	const driver = findDriver(mod);
	if (!driver) {
		throw new DriverResolveError(
			`Driver "${driverSpec}" does not export a valid Driver (must have a send() method)`,
		);
	}

	return {
		driver,
		options: options ?? {},
	};
}

function findDriver(mod: Record<string, unknown>): Driver | null {
	// Prefer default export
	const defaultExport = mod.default as Record<string, unknown> | undefined;
	if (defaultExport && typeof defaultExport.send === "function") {
		return defaultExport as unknown as Driver;
	}

	// Fall back to first named export that looks like a Driver
	for (const value of Object.values(mod)) {
		if (value && typeof value === "object" && typeof (value as Record<string, unknown>).send === "function") {
			return value as unknown as Driver;
		}
	}

	return null;
}

export class DriverResolveError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DriverResolveError";
	}
}
