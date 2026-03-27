import { describe, test, expect } from "bun:test";
import { generateWorkloadId } from "@boilerhouse/core";
import type { Workload } from "@boilerhouse/core";
import { workloads } from "@boilerhouse/db";
import { createTestApp, apiRequest } from "../test-helpers";

const VALID_WORKLOAD: Workload = {
	workload: { name: "my-app", version: "1.0.0" },
	image: { ref: "ghcr.io/test:latest" },
	resources: { vcpus: 1, memory_mb: 512, disk_gb: 2 },
	network: { access: "none" },
	idle: { action: "hibernate" },
};

const MINIMAL_WORKLOAD: Workload = {
	workload: { name: "existing", version: "1.0.0" },
	image: { ref: "ghcr.io/test:latest" },
	resources: { vcpus: 1, memory_mb: 512, disk_gb: 2 },
	network: { access: "none" },
	idle: { action: "hibernate" },
};

describe("POST /api/v1/workloads", () => {
	test("creates a workload from valid JSON", async () => {
		const { app } = createTestApp();

		const res = await apiRequest(app, "/api/v1/workloads", {
			method: "POST",
			body: JSON.stringify(VALID_WORKLOAD),
			headers: { "content-type": "application/json" },
		});

		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.name).toBe("my-app");
		expect(body.version).toBe("1.0.0");
		expect(body.workloadId).toBeDefined();
	});

	test("returns status 'creating' immediately and transitions to 'ready' (no pool)", async () => {
		const { app, db } = createTestApp();

		const res = await apiRequest(app, "/api/v1/workloads", {
			method: "POST",
			body: JSON.stringify(VALID_WORKLOAD),
			headers: { "content-type": "application/json" },
		});

		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.status).toBe("creating");

		// Without a pool manager, workload transitions to ready synchronously
		await new Promise((r) => setTimeout(r, 50));

		const workloadRow = db.select().from(workloads).all();
		expect(workloadRow[0]!.status).toBe("ready");
	});

	test("returns 400 for invalid JSON", async () => {
		const { app } = createTestApp();

		const res = await apiRequest(app, "/api/v1/workloads", {
			method: "POST",
			body: "not valid json {{{{",
			headers: { "content-type": "application/json" },
		});

		expect(res.status).toBe(400);
		const body = await res.json();
		expect(body.error).toBeDefined();
	});

	test("returns 400 for JSON missing required fields", async () => {
		const { app } = createTestApp();

		const res = await apiRequest(app, "/api/v1/workloads", {
			method: "POST",
			body: JSON.stringify({ workload: { name: "foo", version: "1.0.0" } }),
			headers: { "content-type": "application/json" },
		});

		expect(res.status).toBe(400);
	});

	test("returns 409 for duplicate workload name+version", async () => {
		const { app } = createTestApp();

		// First insert
		const res1 = await apiRequest(app, "/api/v1/workloads", {
			method: "POST",
			body: JSON.stringify(VALID_WORKLOAD),
			headers: { "content-type": "application/json" },
		});
		expect(res1.status).toBe(201);

		// Duplicate
		const res2 = await apiRequest(app, "/api/v1/workloads", {
			method: "POST",
			body: JSON.stringify(VALID_WORKLOAD),
			headers: { "content-type": "application/json" },
		});
		expect(res2.status).toBe(409);
	});
});

describe("GET /api/v1/workloads", () => {
	test("returns empty list", async () => {
		const { app } = createTestApp();
		const res = await apiRequest(app, "/api/v1/workloads");

		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([]);
	});

	test("returns list of workloads", async () => {
		const { app, db } = createTestApp();

		const workloadId = generateWorkloadId();
		db.insert(workloads)
			.values({
				workloadId,
				name: "test-app",
				version: "2.0.0",
				config: MINIMAL_WORKLOAD,
				createdAt: new Date(),
				updatedAt: new Date(),
			})
			.run();

		const res = await apiRequest(app, "/api/v1/workloads");
		const body = await res.json();

		expect(body).toHaveLength(1);
		expect(body[0].name).toBe("test-app");
		expect(body[0].version).toBe("2.0.0");
	});
});

describe("GET /api/v1/workloads/:name", () => {
	test("returns workload details with instance count", async () => {
		const { app, db, instanceManager } = createTestApp();

		const workloadId = generateWorkloadId();
		db.insert(workloads)
			.values({
				workloadId,
				name: "detail-app",
				version: "1.0.0",
				config: MINIMAL_WORKLOAD,
				createdAt: new Date(),
				updatedAt: new Date(),
			})
			.run();

		await instanceManager.create(workloadId, MINIMAL_WORKLOAD);

		const res = await apiRequest(app, "/api/v1/workloads/detail-app");
		const body = await res.json();

		expect(res.status).toBe(200);
		expect(body.name).toBe("detail-app");
		expect(body.instanceCount).toBe(1);
		expect(body.config).toBeDefined();
	});

	test("returns 404 for nonexistent workload", async () => {
		const { app } = createTestApp();
		const res = await apiRequest(app, "/api/v1/workloads/nonexistent");

		expect(res.status).toBe(404);
	});
});

describe("GET /api/v1/workloads/:name/snapshots", () => {
	test("returns empty list when no snapshots", async () => {
		const { app, db } = createTestApp();

		const workloadId = generateWorkloadId();
		db.insert(workloads)
			.values({
				workloadId,
				name: "no-snaps",
				version: "1.0.0",
				config: MINIMAL_WORKLOAD,
				createdAt: new Date(),
				updatedAt: new Date(),
			})
			.run();

		const res = await apiRequest(app, "/api/v1/workloads/no-snaps/snapshots");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([]);
	});

	test("returns 404 for nonexistent workload", async () => {
		const { app } = createTestApp();
		const res = await apiRequest(app, "/api/v1/workloads/nope/snapshots");
		expect(res.status).toBe(404);
	});
});

describe("GET /api/v1/workloads/:name/logs", () => {
	test("returns empty array when no logs exist", async () => {
		const { app, db } = createTestApp();

		const workloadId = generateWorkloadId();
		db.insert(workloads)
			.values({
				workloadId,
				name: "no-logs",
				version: "1.0.0",
				config: MINIMAL_WORKLOAD,
				createdAt: new Date(),
				updatedAt: new Date(),
			})
			.run();

		const res = await apiRequest(app, "/api/v1/workloads/no-logs/logs");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([]);
	});

	test("returns 404 for unknown workload", async () => {
		const { app } = createTestApp();
		const res = await apiRequest(app, "/api/v1/workloads/ghost/logs");
		expect(res.status).toBe(404);
	});

	test("returns log entries from bootstrap log store", async () => {
		const { app, db, bootstrapLogStore } = createTestApp();

		const workloadId = generateWorkloadId();
		db.insert(workloads)
			.values({
				workloadId,
				name: "has-logs",
				version: "1.0.0",
				config: MINIMAL_WORKLOAD,
				createdAt: new Date(),
				updatedAt: new Date(),
			})
			.run();

		bootstrapLogStore.append(workloadId, "Pulling image...");
		bootstrapLogStore.append(workloadId, "Creating ext4 image...");

		const res = await apiRequest(app, "/api/v1/workloads/has-logs/logs");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toHaveLength(2);
		expect(body[0].text).toBe("Pulling image...");
		expect(body[1].text).toBe("Creating ext4 image...");
		expect(body[0].timestamp).toBeDefined();
	});
});

describe("DELETE /api/v1/workloads/:name", () => {
	test("deletes workload with no instances", async () => {
		const { app, db } = createTestApp();

		const workloadId = generateWorkloadId();
		db.insert(workloads)
			.values({
				workloadId,
				name: "deletable",
				version: "1.0.0",
				config: MINIMAL_WORKLOAD,
				createdAt: new Date(),
				updatedAt: new Date(),
			})
			.run();

		const res = await apiRequest(app, "/api/v1/workloads/deletable", {
			method: "DELETE",
		});

		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.deleted).toBe(true);
	});

	test("returns 409 when workload has active instances", async () => {
		const { app, db, instanceManager } = createTestApp();

		const workloadId = generateWorkloadId();
		db.insert(workloads)
			.values({
				workloadId,
				name: "busy-app",
				version: "1.0.0",
				config: MINIMAL_WORKLOAD,
				createdAt: new Date(),
				updatedAt: new Date(),
			})
			.run();

		await instanceManager.create(workloadId, MINIMAL_WORKLOAD);

		const res = await apiRequest(app, "/api/v1/workloads/busy-app", {
			method: "DELETE",
		});

		expect(res.status).toBe(409);
		const body = await res.json();
		expect(body.error).toContain("active instance");
	});

	test("returns 404 for nonexistent workload", async () => {
		const { app } = createTestApp();
		const res = await apiRequest(app, "/api/v1/workloads/ghost", {
			method: "DELETE",
		});

		expect(res.status).toBe(404);
	});

	test("allows deletion when all instances are destroyed", async () => {
		const { app, db, instanceManager } = createTestApp();

		const workloadId = generateWorkloadId();
		db.insert(workloads)
			.values({
				workloadId,
				name: "cleanup-app",
				version: "1.0.0",
				config: MINIMAL_WORKLOAD,
				createdAt: new Date(),
				updatedAt: new Date(),
			})
			.run();

		const handle = await instanceManager.create(workloadId, MINIMAL_WORKLOAD);
		await instanceManager.destroy(handle.instanceId);

		const res = await apiRequest(app, "/api/v1/workloads/cleanup-app", {
			method: "DELETE",
		});

		expect(res.status).toBe(200);
	});
});
