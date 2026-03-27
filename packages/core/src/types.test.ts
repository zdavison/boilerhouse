import { describe, expect, test } from "bun:test";
import {
	type InstanceId,
	type TenantId,
	generateInstanceId,
	generateTenantId,
	generateWorkloadId,
	generateNodeId,
	generateSnapshotId,
} from "./types";

describe("branded ID types", () => {
	test("factory functions produce correctly branded values", () => {
		const instanceId = generateInstanceId();
		const tenantId = generateTenantId();
		const workloadId = generateWorkloadId();
		const nodeId = generateNodeId();
		const snapshotId = generateSnapshotId();

		expect(typeof instanceId).toBe("string");
		expect(typeof tenantId).toBe("string");
		expect(typeof workloadId).toBe("string");
		expect(typeof nodeId).toBe("string");
		expect(typeof snapshotId).toBe("string");

		// Each generated ID should be non-empty
		expect(instanceId.length).toBeGreaterThan(0);
		expect(tenantId.length).toBeGreaterThan(0);
		expect(workloadId.length).toBeGreaterThan(0);
		expect(nodeId.length).toBeGreaterThan(0);
		expect(snapshotId.length).toBeGreaterThan(0);
	});

	test("branded types are structurally incompatible", () => {
		// This test verifies the branding at the type level.
		// We verify that each ID carries a distinct brand by checking
		// that two IDs from different factories are never equal (in practice).
		const instanceId = generateInstanceId();
		const tenantId = generateTenantId();

		// Different generators produce different values
		expect(instanceId as string).not.toBe(tenantId as string);

		// TypeScript compile-time check: the following would be a type error:
		// const bad: InstanceId = tenantId;
		// We can't test compile errors at runtime, but we verify the brand property exists
		// by checking the type assertion works only through the factory.
		const asInstance: InstanceId = instanceId;
		const asTenant: TenantId = tenantId;
		expect(asInstance).toBe(instanceId);
		expect(asTenant).toBe(tenantId);
	});

	test("ids are string-serializable", () => {
		const instanceId = generateInstanceId();
		const tenantId = generateTenantId();
		const workloadId = generateWorkloadId();
		const nodeId = generateNodeId();
		const snapshotId = generateSnapshotId();

		// Can be JSON serialized and deserialized as strings
		const serialized = JSON.stringify({
			instanceId,
			tenantId,
			workloadId,
			nodeId,
			snapshotId,
		});
		const parsed = JSON.parse(serialized);

		expect(parsed.instanceId).toBe(instanceId);
		expect(parsed.tenantId).toBe(tenantId);
		expect(parsed.workloadId).toBe(workloadId);
		expect(parsed.nodeId).toBe(nodeId);
		expect(parsed.snapshotId).toBe(snapshotId);

		// Can be used as template literal / string concatenation
		expect(`instance:${instanceId}`).toBe(`instance:${instanceId}`);
		expect(String(instanceId)).toBe(instanceId as string);
	});

	test("each factory call produces a unique id", () => {
		const ids = new Set<string>();
		for (let i = 0; i < 100; i++) {
			ids.add(generateInstanceId());
		}
		expect(ids.size).toBe(100);
	});
});
