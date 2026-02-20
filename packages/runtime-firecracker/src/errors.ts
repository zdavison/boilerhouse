import type { InstanceId } from "@boilerhouse/core";

/** Base error for all Firecracker runtime errors. */
export class FirecrackerError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "FirecrackerError";
	}
}

/** Error returned by the Firecracker HTTP API. */
export class FirecrackerApiError extends FirecrackerError {
	constructor(
		public readonly statusCode: number,
		public readonly endpoint: string,
		public readonly faultMessage: string,
	) {
		super(
			`Firecracker API error ${statusCode} on ${endpoint}: ${faultMessage}`,
		);
		this.name = "FirecrackerApiError";
	}
}

/** Error spawning, managing, or communicating with the Firecracker process. */
export class FirecrackerProcessError extends FirecrackerError {
	constructor(
		message: string,
		public readonly exitCode?: number,
	) {
		super(message);
		this.name = "FirecrackerProcessError";
	}
}

/** Attempted operation on an instance that does not exist in the runtime. */
export class InstanceNotFoundError extends FirecrackerError {
	constructor(public readonly instanceId: InstanceId) {
		super(`Instance not found: ${instanceId}`);
		this.name = "InstanceNotFoundError";
	}
}

/** Error during snapshot creation or restoration. */
export class SnapshotError extends FirecrackerError {
	constructor(message: string) {
		super(message);
		this.name = "SnapshotError";
	}
}

/** Error during rootfs overlay creation or removal. */
export class OverlayError extends FirecrackerError {
	constructor(message: string) {
		super(message);
		this.name = "OverlayError";
	}
}
