import pino from "pino";
import type { Logger } from "pino";

export type { Logger };

const isProduction = process.env.NODE_ENV === "production";

const baseLogger = pino({
	level: process.env.LOG_LEVEL ?? "info",
	transport: isProduction
		? undefined
		: { target: "pino-pretty", options: { colorize: true } },
});

/**
 * Creates a named child logger.
 *
 * @param name - Component name for log context (e.g. "TenantManager", "GoldenCreator")
 */
export function createLogger(name: string): Logger {
	return baseLogger.child({ component: name });
}
