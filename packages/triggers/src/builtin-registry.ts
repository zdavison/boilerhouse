/**
 * Static registry of built-in guards and drivers.
 * These are imported at build time so they're bundled into compiled binaries,
 * avoiding dynamic import() of monorepo paths that don't exist at runtime.
 */

import type { Guard } from "./guard";
import type { Driver } from "./driver";

import apiGuard from "@boilerhouse/guard-api";
import allowlistGuard from "@boilerhouse/guard-allowlist";
import { openclawDriver } from "@boilerhouse/driver-openclaw";
import { claudeCodeDriver } from "@boilerhouse/driver-claude-code";
import { piDriver } from "@boilerhouse/driver-pi";

export const builtinGuards: Record<string, Guard> = {
	"@boilerhouse/guard-api": apiGuard,
	"@boilerhouse/guard-allowlist": allowlistGuard,
};

export const builtinDrivers: Record<string, Driver> = {
	"@boilerhouse/driver-openclaw": openclawDriver,
	"@boilerhouse/driver-claude-code": claudeCodeDriver,
	"@boilerhouse/driver-pi": piDriver,
};
