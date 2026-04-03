import { randomBytes } from "node:crypto";
import { FakeRuntime, generateNodeId } from "@boilerhouse/core";
import type { NodeId } from "@boilerhouse/core";
import { createTestDatabase, ActivityLog } from "@boilerhouse/db";
import type { DrizzleDb } from "@boilerhouse/db";
import { nodes } from "@boilerhouse/db";
import { createLogger } from "@boilerhouse/o11y";
import {
	InstanceManager,
	TenantManager,
	TenantDataStore,
	EventBus,
	AuditLogger,
	BootstrapLogStore,
} from "@boilerhouse/domain";
import { ResourceLimiter } from "./resource-limits";
import { SecretStore } from "./secret-store";
import { createApp } from "./app";
import type { RouteDeps } from "./routes/deps";

export { createTestAudit } from "@boilerhouse/domain";

export interface TestContext extends RouteDeps {
	app: ReturnType<typeof createApp>;
}

/**
 * Creates a fully wired test app with in-memory DB and FakeRuntime.
 * Registers a default node so FK constraints are satisfied.
 */
export function createTestApp(overrides?: Partial<RouteDeps>): TestContext {
	const db = createTestDatabase();
	const runtime = new FakeRuntime();
	const nodeId = generateNodeId();
	const activityLog = new ActivityLog(db);
	const eventBus = new EventBus();
	const audit = new AuditLogger(activityLog, eventBus, nodeId);

	// Insert a node row so FK constraints pass
	db.insert(nodes).values({
		nodeId,
		runtimeType: "podman",
		capacity: { vcpus: 8, memoryMb: 16384, diskGb: 100 },
		status: "online",
		lastHeartbeat: new Date(),
		createdAt: new Date(),
	}).run();

	const log = createLogger("test");
	const instanceManager = new InstanceManager(runtime, db, audit, nodeId, log);
	const tenantDataStore = new TenantDataStore("/tmp/boilerhouse-test", db, runtime);
	const tenantManager = new TenantManager(
		instanceManager,
		db,
		audit,
		nodeId,
		tenantDataStore,
		{ log },
	);

	const resourceLimiter = new ResourceLimiter(db, { maxInstances: 100 });
	const bootstrapLogStore = new BootstrapLogStore(db);
	const secretStore = new SecretStore(db, randomBytes(32).toString("hex"));

	const deps: RouteDeps = {
		db,
		runtime,
		nodeId,
		activityLog,
		instanceManager,
		tenantManager,
		eventBus,
		bootstrapLogStore,
		resourceLimiter,
		secretStore,
		log,
		...overrides,
	};

	const app = createApp(deps);

	return { ...deps, app };
}

/**
 * Sends a request to the app and returns the response.
 * Convenience wrapper around `app.handle()`.
 */
export async function apiRequest(
	app: ReturnType<typeof createApp>,
	path: string,
	options?: RequestInit,
): Promise<Response> {
	const url = `http://localhost${path}`;
	return app.handle(new Request(url, options));
}
