import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { parse as parseTOML } from "smol-toml";

// ── Sub-schemas ──────────────────────────────────────────────────────────────

const PortExposeSchema = Type.Object({
	guest: Type.Integer({ exclusiveMinimum: 0 }),
	host_range: Type.Tuple([Type.Integer(), Type.Integer()]),
});

const BindMountSchema = Type.Object({
	host: Type.String({ minLength: 1 }),
	guest: Type.String({ minLength: 1 }),
	readonly: Type.Optional(Type.Boolean()),
});

const NetworkAccessSchema = Type.Union([
	Type.Literal("none"),
	Type.Literal("outbound"),
	Type.Literal("restricted"),
]);

const IdleActionSchema = Type.Union([
	Type.Literal("hibernate"),
	Type.Literal("destroy"),
]);

// ── Main schema ──────────────────────────────────────────────────────────────

export const WorkloadSchema = Type.Object({
	workload: Type.Object({
		name: Type.String({ minLength: 1 }),
		version: Type.String({ minLength: 1 }),
	}),
	image: Type.Object({
		/** OCI image reference. Mutually exclusive with `dockerfile`. */
		ref: Type.Optional(Type.String({ minLength: 1 })),
		/** Path to a Dockerfile. Mutually exclusive with `ref`. */
		dockerfile: Type.Optional(Type.String({ minLength: 1 })),
	}),
	resources: Type.Object({
		vcpus: Type.Number({ exclusiveMinimum: 0 }),
		memory_mb: Type.Number({ exclusiveMinimum: 0 }),
		/** @default 2 */
		disk_gb: Type.Number({ exclusiveMinimum: 0 }),
	}),
	network: Type.Object({
		/**
		 * Network access policy.
		 * @default "none"
		 */
		access: NetworkAccessSchema,
		allowlist: Type.Optional(Type.Array(Type.String())),
		expose: Type.Optional(Type.Array(PortExposeSchema)),
	}),
	filesystem: Type.Optional(
		Type.Object({
			overlay_dirs: Type.Optional(Type.Array(Type.String())),
			bind_mounts: Type.Optional(Type.Array(BindMountSchema)),
		}),
	),
	idle: Type.Object({
		watch_dirs: Type.Optional(Type.Array(Type.String())),
		timeout_seconds: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
		/**
		 * What to do when idle.
		 * @default "hibernate"
		 */
		action: IdleActionSchema,
	}),
	health: Type.Optional(
		Type.Object({
			endpoint: Type.String({ minLength: 1 }),
			interval_seconds: Type.Number({ exclusiveMinimum: 0 }),
			unhealthy_threshold: Type.Number({ exclusiveMinimum: 0 }),
		}),
	),
	entrypoint: Type.Optional(
		Type.Object({
			cmd: Type.String({ minLength: 1 }),
			args: Type.Optional(Type.Array(Type.String())),
			env: Type.Optional(Type.Record(Type.String(), Type.String())),
		}),
	),
	/** Arbitrary key-value pairs passed through to the API. */
	metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

// ── Types derived from schema ────────────────────────────────────────────────

export type Workload = Static<typeof WorkloadSchema>;
export type NetworkAccess = Static<typeof NetworkAccessSchema>;
export type IdleAction = Static<typeof IdleActionSchema>;
export type PortExpose = Static<typeof PortExposeSchema>;
export type BindMount = Static<typeof BindMountSchema>;

// ── Error class ──────────────────────────────────────────────────────────────

export class WorkloadParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkloadParseError";
	}
}

// ── Parser ───────────────────────────────────────────────────────────────────

/**
 * Parses a workload TOML string and returns a validated {@link Workload}.
 * Throws {@link WorkloadParseError} for any validation failures.
 */
export function parseWorkload(toml: string): Workload {
	let raw: Record<string, unknown>;
	try {
		raw = parseTOML(toml) as Record<string, unknown>;
	} catch (e) {
		throw new WorkloadParseError(
			`Invalid TOML: ${e instanceof Error ? e.message : String(e)}`,
		);
	}

	applyDefaults(raw);
	checkImageMutualExclusivity(raw);

	if (!Value.Check(WorkloadSchema, raw)) {
		const errors = [...Value.Errors(WorkloadSchema, raw)];
		const messages = errors.map(
			(err) => `${err.path}: ${err.message}`,
		);
		throw new WorkloadParseError(
			`Invalid workload definition:\n${messages.join("\n")}`,
		);
	}

	return raw as Workload;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function applyDefaults(raw: Record<string, unknown>): void {
	// resources.disk_gb defaults to 2
	const resources = raw.resources as Record<string, unknown> | undefined;
	if (resources && resources.disk_gb === undefined) {
		resources.disk_gb = 2;
	}

	// network defaults to { access: "none" }
	if (raw.network === undefined) {
		raw.network = { access: "none" };
	} else {
		const network = raw.network as Record<string, unknown>;
		if (network.access === undefined) {
			network.access = "none";
		}
	}

	// idle defaults to { action: "hibernate" }
	if (raw.idle === undefined) {
		raw.idle = { action: "hibernate" };
	} else {
		const idle = raw.idle as Record<string, unknown>;
		if (idle.action === undefined) {
			idle.action = "hibernate";
		}
	}
}

function checkImageMutualExclusivity(raw: Record<string, unknown>): void {
	const image = raw.image as Record<string, unknown> | undefined;
	if (!image) return;

	const hasRef = image.ref !== undefined;
	const hasDockerfile = image.dockerfile !== undefined;

	if (hasRef && hasDockerfile) {
		throw new WorkloadParseError(
			"image.ref and image.dockerfile are mutually exclusive — set only one",
		);
	}
	if (!hasRef && !hasDockerfile) {
		throw new WorkloadParseError(
			"image section requires either 'ref' or 'dockerfile'",
		);
	}
}
