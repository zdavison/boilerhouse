import { Elysia } from "elysia";
import { WorkloadParseError } from "@boilerhouse/core";
import { NoGoldenSnapshotError } from "../tenant-manager";
import { SnapshotNotFoundError } from "../instance-manager";

export const errorHandler = new Elysia({ name: "error-handler" }).onError(
	({ error, set }) => {
		if (error instanceof WorkloadParseError) {
			set.status = 400;
			return { error: error.message };
		}

		if (error instanceof SnapshotNotFoundError) {
			set.status = 404;
			return { error: error.message };
		}

		if (error instanceof NoGoldenSnapshotError) {
			set.status = 503;
			return { error: error.message };
		}

		// Elysia's NOT_FOUND
		if (
			"code" in error &&
			(error as { code: string }).code === "NOT_FOUND"
		) {
			set.status = 404;
			return { error: "Not found" };
		}

		set.status = 500;
		return { error: "Internal server error" };
	},
);
