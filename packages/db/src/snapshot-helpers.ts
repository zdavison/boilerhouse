import type { SnapshotRef, SnapshotMetadata } from "@boilerhouse/core";
import type { SnapshotRow } from "./schema";

/**
 * Converts a snapshot DB row to a {@link SnapshotRef}, validating
 * that runtimeMeta contains the required fields.
 *
 * Returns `null` if the row has no runtimeMeta or if any required
 * field is missing/wrong-typed.
 */
export function snapshotRefFrom(row: SnapshotRow): SnapshotRef | null {
	const meta = row.runtimeMeta as Record<string, unknown> | null;
	if (
		!meta ||
		typeof meta.runtimeVersion !== "string" ||
		typeof meta.cpuTemplate !== "string" ||
		typeof meta.architecture !== "string"
	) {
		return null;
	}

	return {
		id: row.snapshotId,
		type: row.type,
		paths: {
			memory: row.memoryPath ?? "",
			vmstate: row.vmstatePath,
		},
		workloadId: row.workloadId,
		nodeId: row.nodeId,
		runtimeMeta: meta as unknown as SnapshotMetadata,
	};
}
