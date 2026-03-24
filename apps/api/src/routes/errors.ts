import { Elysia } from "elysia";
import { InvalidTransitionError } from "@boilerhouse/core";
import { SnapshotNotFoundError } from "../instance-manager";

export const errorHandler = new Elysia({ name: "error-handler" }).onError(
	({ error, set }) => {
		if (error instanceof InvalidTransitionError) {
			set.status = 409;
			return { error: error.message };
		}

		if (error instanceof SnapshotNotFoundError) {
			set.status = 404;
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

		console.error("Unhandled API error:", error);
		set.status = 500;
		const message = error instanceof Error ? error.message : "Internal server error";
		return { error: message };
	},
);
