import { generateNodeId } from "@boilerhouse/core";
import type { NodeId } from "@boilerhouse/core";
import { ActivityLog } from "@boilerhouse/db";
import type { DrizzleDb } from "@boilerhouse/db";
import { EventBus } from "./event-bus";
import { AuditLogger } from "./audit-logger";

/**
 * Creates an AuditLogger backed by a real ActivityLog and a fresh EventBus.
 * Suitable for unit tests where you need audit calls to not throw.
 */
export function createTestAudit(db: DrizzleDb, nodeId?: NodeId): AuditLogger {
	return new AuditLogger(new ActivityLog(db), new EventBus(), nodeId ?? generateNodeId());
}
