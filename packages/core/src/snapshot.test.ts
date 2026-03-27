import { describe, expect, test } from "bun:test";
import {
	type SnapshotRef,
	type SnapshotMetadata,
	createSnapshotRef,
	isGoldenSnapshot,
	isTenantSnapshot,
} from "./snapshot";
import {
	generateSnapshotId,
	generateWorkloadId,
	generateNodeId,
	generateTenantId,
} from "./types";

describe("snapshot types", () => {
	test("SnapshotRef serialization/deserialization", () => {
		const ref = createSnapshotRef({
			id: generateSnapshotId(),
			type: "golden",
			paths: {
				memory: "/snapshots/abc/checkpoint.tar.gz",
				vmstate: "/snapshots/abc/checkpoint.tar.gz",
			},
			workloadId: generateWorkloadId(),
			nodeId: generateNodeId(),
			runtimeMeta: {
				runtimeVersion: "5.4.2",
				architecture: "x86_64",
			},
		});

		const serialized = JSON.stringify(ref);
		const deserialized: SnapshotRef = JSON.parse(serialized);

		expect(deserialized.id).toBe(ref.id);
		expect(deserialized.type).toBe("golden");
		expect(deserialized.paths.memory).toBe(ref.paths.memory);
		expect(deserialized.paths.vmstate).toBe(ref.paths.vmstate);
		expect(deserialized.workloadId).toBe(ref.workloadId);
		expect(deserialized.nodeId).toBe(ref.nodeId);
		expect(deserialized.tenantId).toBeUndefined();
		expect(deserialized.runtimeMeta.runtimeVersion).toBe("5.4.2");
		expect(deserialized.runtimeMeta.architecture).toBe("x86_64");
	});

	test("golden vs tenant snapshot type discrimination", () => {
		const goldenRef = createSnapshotRef({
			id: generateSnapshotId(),
			type: "golden",
			paths: { memory: "/snap/golden/checkpoint.tar.gz", vmstate: "/snap/golden/checkpoint.tar.gz" },
			workloadId: generateWorkloadId(),
			nodeId: generateNodeId(),
			runtimeMeta: {
				runtimeVersion: "5.4.2",
				architecture: "x86_64",
			},
		});

		const tenantRef = createSnapshotRef({
			id: generateSnapshotId(),
			type: "tenant",
			paths: { memory: "/snap/tenant/checkpoint.tar.gz", vmstate: "/snap/tenant/checkpoint.tar.gz" },
			workloadId: generateWorkloadId(),
			nodeId: generateNodeId(),
			tenantId: generateTenantId(),
			runtimeMeta: {
				runtimeVersion: "5.4.2",
				architecture: "arm64",
			},
		});

		expect(isGoldenSnapshot(goldenRef)).toBe(true);
		expect(isTenantSnapshot(goldenRef)).toBe(false);
		expect(isGoldenSnapshot(tenantRef)).toBe(false);
		expect(isTenantSnapshot(tenantRef)).toBe(true);

		expect(goldenRef.tenantId).toBeUndefined();
		expect(tenantRef.tenantId).toBeDefined();
	});

	test("snapshot metadata includes runtimeMeta", () => {
		const meta: SnapshotMetadata = {
			runtimeVersion: "5.4.2",
			architecture: "x86_64",
		};

		const ref = createSnapshotRef({
			id: generateSnapshotId(),
			type: "golden",
			paths: { memory: "/snap/checkpoint.tar.gz", vmstate: "/snap/checkpoint.tar.gz" },
			workloadId: generateWorkloadId(),
			nodeId: generateNodeId(),
			runtimeMeta: meta,
		});

		expect(ref.runtimeMeta).toEqual(meta);
		expect(ref.runtimeMeta.runtimeVersion).toBe("5.4.2");
		expect(ref.runtimeMeta.architecture).toBe("x86_64");
	});
});
