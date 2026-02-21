import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FakeRuntime, generateNodeId } from "@boilerhouse/core";
import type { Runtime } from "@boilerhouse/core";
import { createTestDatabase, ActivityLog, nodes } from "@boilerhouse/db";
import type { DrizzleDb } from "@boilerhouse/db";
import { FirecrackerRuntime } from "@boilerhouse/runtime-firecracker";
import { InstanceManager } from "../instance-manager";
import { SnapshotManager } from "../snapshot-manager";
import { TenantManager } from "../tenant-manager";
import { TenantDataStore } from "../tenant-data";
import { EventBus } from "../event-bus";
import { GoldenCreator } from "../golden-creator";
import { ResourceLimiter } from "../resource-limits";
import { TapManager } from "../network/tap";
import { createApp } from "../app";
import { E2E_TIMEOUTS } from "./runtime-matrix";

type RuntimeOperation =
	| "create"
	| "start"
	| "stop"
	| "destroy"
	| "snapshot"
	| "restore"
	| "exec"
	| "getEndpoint"
	| "list";

export interface E2EServer {
	/** Base URL including port, e.g. "http://localhost:54321" */
	baseUrl: string;
	/** Direct DB handle for read assertions only */
	db: DrizzleDb;
	/** Stops server, destroys resources, removes temp files */
	cleanup: () => Promise<void>;
	/**
	 * Mutable set controlling FakeRuntime failure injection.
	 * Only present when runtimeName is "fake".
	 * Add operation names to make the runtime throw.
	 */
	fakeFailOn?: Set<RuntimeOperation>;
}

/**
 * Boots the API server with the given runtime wired in.
 * Starts on a random port and returns a handle for tests.
 */
export async function startE2EServer(runtimeName: string): Promise<E2EServer> {
	const db = createTestDatabase();
	const nodeId = generateNodeId();
	const activityLog = new ActivityLog(db);
	const eventBus = new EventBus();

	// Insert a node so FK constraints pass
	db.insert(nodes)
		.values({
			nodeId,
			runtimeType: "firecracker",
			capacity: { vcpus: 8, memoryMb: 16384, diskGb: 100 },
			status: "online",
			lastHeartbeat: new Date(),
			createdAt: new Date(),
		})
		.run();

	let runtime: Runtime;
	let fakeFailOn: Set<RuntimeOperation> | undefined;
	let runtimeCleanup: (() => Promise<void>) | undefined;

	if (runtimeName === "fake") {
		fakeFailOn = new Set<RuntimeOperation>();
		runtime = new FakeRuntime({ failOn: fakeFailOn });
	} else if (runtimeName === "firecracker") {
		const instanceDir = mkdtempSync(join(tmpdir(), "bh-e2e-fc-inst-"));
		const snapshotDir = mkdtempSync(join(tmpdir(), "bh-e2e-fc-snap-"));

		const binaryPath =
			process.env.FIRECRACKER_BIN ?? "/usr/local/bin/firecracker";
		const kernelPath =
			process.env.FIRECRACKER_KERNEL ?? "/var/lib/boilerhouse/vmlinux";
		const imagesDir =
			process.env.FIRECRACKER_IMAGES_DIR ?? "/var/lib/boilerhouse/images";

		const tapManager = new TapManager();
		const fcRuntime = new FirecrackerRuntime({
			binaryPath,
			kernelPath,
			instanceDir,
			snapshotDir,
			imagesDir,
			nodeId,
			tapManager,
		});
		runtime = fcRuntime;

		runtimeCleanup = async () => {
			const ids = await fcRuntime.list();
			for (const id of ids) {
				try {
					await fcRuntime.destroy({ instanceId: id, running: false });
				} catch {
					// Best-effort cleanup
				}
			}
			rmSync(instanceDir, { recursive: true, force: true });
			rmSync(snapshotDir, { recursive: true, force: true });
		};
	} else {
		throw new Error(`Runtime '${runtimeName}' not implemented for E2E`);
	}

	const instanceManager = new InstanceManager(
		runtime,
		db,
		activityLog,
		nodeId,
	);
	const snapshotManager = new SnapshotManager(runtime, db, nodeId, {
		healthChecker: async () => {},
	});
	const tenantDataStore = new TenantDataStore("/tmp/boilerhouse-e2e", db);
	const tenantManager = new TenantManager(
		instanceManager,
		snapshotManager,
		db,
		activityLog,
		runtime,
		nodeId,
		tenantDataStore,
	);

	const resourceLimiter = new ResourceLimiter(db, { maxInstances: 100 });
	const goldenCreator = new GoldenCreator(db, snapshotManager, eventBus);

	const app = createApp({
		db,
		runtime,
		nodeId,
		activityLog,
		instanceManager,
		tenantManager,
		snapshotManager,
		eventBus,
		goldenCreator,
		resourceLimiter,
	});

	const server = app.listen(0);
	const port = server.server!.port;
	const baseUrl = `http://localhost:${port}`;

	return {
		baseUrl,
		db,
		fakeFailOn,
		cleanup: async () => {
			server.stop();
			resourceLimiter.dispose();
			if (runtimeCleanup) await runtimeCleanup();
		},
	};
}

/**
 * Waits for a workload to reach "ready" status by polling.
 * Throws if the workload doesn't become ready within the timeout.
 */
export async function waitForWorkloadReady(
	server: E2EServer,
	workloadName: string,
	timeoutMs = 30_000,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const res = await fetch(
			`${server.baseUrl}/api/v1/workloads/${encodeURIComponent(workloadName)}`,
		);
		if (res.ok) {
			const body = (await res.json()) as { status: string };
			if (body.status === "ready") return;
			if (body.status === "error") {
				throw new Error(`Workload '${workloadName}' failed to create golden snapshot`);
			}
		}
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`Workload '${workloadName}' did not become ready within ${timeoutMs}ms`);
}

/**
 * Typed fetch wrapper against the E2E server.
 * Handles JSON serialization of request bodies.
 */
export async function api(
	server: E2EServer,
	method: string,
	path: string,
	body?: unknown,
): Promise<Response> {
	const url = `${server.baseUrl}${path}`;
	const headers: Record<string, string> = {};
	let reqBody: string | undefined;

	if (body !== undefined) {
		if (typeof body === "string") {
			// TOML or other text bodies
			headers["Content-Type"] = "text/plain";
			reqBody = body;
		} else {
			headers["Content-Type"] = "application/json";
			reqBody = JSON.stringify(body);
		}
	}

	return fetch(url, {
		method,
		headers,
		body: reqBody,
	});
}

/**
 * Reads a workload fixture file and returns its TOML content.
 */
export async function readFixture(path: string): Promise<string> {
	return Bun.file(path).text();
}

/**
 * Returns the operation timeout for a given runtime.
 */
export function timeoutFor(
	runtimeName: string,
): (typeof E2E_TIMEOUTS)[keyof typeof E2E_TIMEOUTS] {
	return (
		E2E_TIMEOUTS[runtimeName as keyof typeof E2E_TIMEOUTS] ??
		E2E_TIMEOUTS.fake
	);
}
