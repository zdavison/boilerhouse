import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

// ── SecretRef ────────────────────────────────────────────────────────────────

const SECRET_BRAND = Symbol("SecretRef");

export interface SecretRef {
	[SECRET_BRAND]: true;
	name: string;
}

/**
 * Marks a header value as a secret reference, resolved at request time.
 * @example secret("ANTHROPIC_API_KEY") → serialized as "${global-secret:ANTHROPIC_API_KEY}"
 */
export function secret(name: string): SecretRef {
	return { [SECRET_BRAND]: true, name };
}

export function isSecretRef(value: unknown): value is SecretRef {
	return typeof value === "object" && value !== null && SECRET_BRAND in value;
}

// ── Sub-schemas ──────────────────────────────────────────────────────────────

const PortExposeSchema = Type.Object({
	guest: Type.Integer({ exclusiveMinimum: 0 }),
	host_range: Type.Tuple([Type.Integer(), Type.Integer()]),
});

const NetworkAccessSchema = Type.Union([
	Type.Literal("none"),
	Type.Literal("outbound"),
	Type.Literal("restricted"),
], { default: "none" });

const CredentialRuleSchema = Type.Object({
	/** Domain this credential rule applies to (e.g. "api.anthropic.com"). */
	domain: Type.String({ minLength: 1 }),
	/**
	 * Headers to inject into outbound requests to this domain.
	 * Values may contain `${global-secret:NAME}` or `${tenant-secret:NAME}`
	 * references resolved at request time.
	 * @example { "x-api-key": "${global-secret:ANTHROPIC_API_KEY}" }
	 */
	headers: Type.Record(Type.String(), Type.String()),
});

const IdleActionSchema = Type.Union([
	Type.Literal("hibernate"),
	Type.Literal("destroy"),
], { default: "hibernate" });

const HttpGetProbeSchema = Type.Object({
	/** Path to probe. */
	path: Type.String({ minLength: 1 }),
	/**
	 * Port to probe.
	 * @default VM's primary endpoint port
	 */
	port: Type.Optional(Type.Integer({ exclusiveMinimum: 0 })),
});

const ExecProbeSchema = Type.Object({
	/**
	 * Command to execute inside the guest VM. Exit code 0 = healthy.
	 * @example ["cat", "/tmp/healthy"]
	 */
	command: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
});

// ── Main schema ──────────────────────────────────────────────────────────────

export const WorkloadSchema = Type.Object({
	workload: Type.Object({
		name: Type.String({ minLength: 1, pattern: "^[a-zA-Z0-9][a-zA-Z0-9._-]*$" }),
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
		disk_gb: Type.Number({ exclusiveMinimum: 0, default: 2 }),
	}),
	/** @default { access: "none" } */
	network: Type.Object({
		/**
		 * Network access policy.
		 * @default "none"
		 */
		access: NetworkAccessSchema,
		allowlist: Type.Optional(Type.Array(Type.String())),
		expose: Type.Optional(Type.Array(PortExposeSchema)),
		/**
		 * Credential rules for outbound HTTP requests.
		 * The proxy injects specified headers when the container makes
		 * requests to the matching domain.
		 */
		credentials: Type.Optional(Type.Array(CredentialRuleSchema)),
		/**
		 * Path where the container accepts WebSocket upgrades.
		 * When set, the trigger layer uses a persistent WebSocket connection
		 * instead of HTTP POST per message.
		 * @example "/ws"
		 */
		websocket: Type.Optional(Type.String({ minLength: 1 })),
	}, { default: { access: "none" } }),
	filesystem: Type.Optional(
		Type.Object({
			overlay_dirs: Type.Optional(Type.Array(Type.String())),
		}),
	),
	/** @default { action: "hibernate" } */
	idle: Type.Object({
		watch_dirs: Type.Optional(Type.Array(Type.String())),
		timeout_seconds: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
		/**
		 * What to do when idle.
		 * @default "hibernate"
		 */
		action: IdleActionSchema,
	}, { default: { action: "hibernate" } }),
	health: Type.Optional(
		Type.Object({
			interval_seconds: Type.Number({ exclusiveMinimum: 0 }),
			unhealthy_threshold: Type.Number({ exclusiveMinimum: 0 }),
			/**
			 * Maximum time in seconds for a single health check execution
			 * before it's killed. Applies to exec probes run by the guest
			 * health-agent.
			 * @default 60
			 */
			check_timeout_seconds: Type.Optional(
				Type.Number({ exclusiveMinimum: 0, default: 60 }),
			),
			http_get: Type.Optional(HttpGetProbeSchema),
			exec: Type.Optional(ExecProbeSchema),
		}),
	),
	entrypoint: Type.Optional(
		Type.Object({
			cmd: Type.String({ minLength: 1 }),
			args: Type.Optional(Type.Array(Type.String())),
			env: Type.Optional(Type.Record(Type.String(), Type.String())),
			/**
			 * Working directory for the entrypoint and health check processes.
			 * Corresponds to the container image's WORKDIR.
			 * @example "/app"
			 */
			workdir: Type.Optional(Type.String({ minLength: 1 })),
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
export type HttpGetProbe = Static<typeof HttpGetProbeSchema>;
export type ExecProbe = Static<typeof ExecProbeSchema>;
export type CredentialRule = Static<typeof CredentialRuleSchema>;

// ── Error class ──────────────────────────────────────────────────────────────

export class WorkloadParseError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "WorkloadParseError";
	}
}

// ── Validators ──────────────────────────────────────────────────────────────

/**
 * Validates an unknown JSON body against the {@link WorkloadSchema}.
 * Applies defaults and runs custom validation checks.
 * Throws {@link WorkloadParseError} on any validation failures.
 */
export function validateWorkload(body: unknown): Workload {
	const raw = body as Record<string, unknown>;
	Value.Default(WorkloadSchema, raw);
	checkImageMutualExclusivity(raw);
	checkHealthProbeMutualExclusivity(raw);
	checkCredentialConstraints(raw);

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

function checkHealthProbeMutualExclusivity(raw: Record<string, unknown>): void {
	const health = raw.health as Record<string, unknown> | undefined;
	if (!health) return;

	const hasHttpGet = health.http_get !== undefined;
	const hasExec = health.exec !== undefined;

	if (hasHttpGet && hasExec) {
		throw new WorkloadParseError(
			"health.http_get and health.exec are mutually exclusive — set only one",
		);
	}
	if (!hasHttpGet && !hasExec) {
		throw new WorkloadParseError(
			"health section requires either 'http_get' or 'exec'",
		);
	}
}

function checkCredentialConstraints(raw: Record<string, unknown>): void {
	const network = raw.network as Record<string, unknown> | undefined;
	if (!network) return;

	const credentials = network.credentials as Array<Record<string, unknown>> | undefined;
	if (!credentials || credentials.length === 0) return;

	const access = (network.access ?? "none") as string;

	if (access === "none") {
		throw new WorkloadParseError(
			"network.credentials cannot be used when network.access is 'none'",
		);
	}

	if (access === "restricted") {
		const allowlist = (network.allowlist ?? []) as string[];
		for (const rule of credentials) {
			const domain = rule.domain as string;
			if (!allowlist.includes(domain)) {
				throw new WorkloadParseError(
					`Credential domain '${domain}' is not in the network allowlist`,
				);
			}
		}
	}
}

// ── TypeScript config API ────────────────────────────────────────────────────

/** Header value in a WorkloadConfig — either a literal string or a secret reference. */
type HeaderValue = string | SecretRef;

/** Credential rule in user-facing config — header values accept SecretRef. */
interface WorkloadConfigCredentialRule {
	domain: string;
	headers: Record<string, HeaderValue>;
}

/**
 * User-facing workload configuration shape. Compared to the canonical
 * {@link Workload} stored in the DB:
 * - `name` and `version` are top-level (no `workload` wrapper)
 * - Credential header values accept `SecretRef` (serialized on resolve)
 * - Optional fields may be omitted entirely (defaults applied on resolve)
 */
export interface WorkloadConfig {
	name: string;
	version: string;
	image: { ref?: string; dockerfile?: string };
	resources: { vcpus: number; memory_mb: number; disk_gb?: number };
	network?: {
		/** @default "none" */
		access?: NetworkAccess;
		allowlist?: string[];
		expose?: Array<{ guest: number; host_range: [number, number] }>;
		credentials?: WorkloadConfigCredentialRule[];
		/** Path where the container accepts WebSocket upgrades.
		 * @example "/ws"
		 */
		websocket?: string;
	};
	filesystem?: {
		overlay_dirs?: string[];
	};
	idle?: {
		watch_dirs?: string[];
		timeout_seconds?: number;
		/** @default "hibernate" */
		action?: IdleAction;
	};
	health?: {
		interval_seconds: number;
		unhealthy_threshold: number;
		/** @default 60 */
		check_timeout_seconds?: number;
		http_get?: { path: string; port?: number };
		exec?: { command: string[] };
	};
	entrypoint?: {
		cmd: string;
		args?: string[];
		env?: Record<string, string>;
		workdir?: string;
	};
	metadata?: Record<string, unknown>;
}

/**
 * Identity function that provides type checking for workload config files.
 * @example
 * ```ts
 * export default defineWorkload({ name: "my-app", ... });
 * ```
 */
export function defineWorkload(config: WorkloadConfig): WorkloadConfig {
	return config;
}

/**
 * Converts a user-facing {@link WorkloadConfig} into the canonical
 * {@link Workload} shape stored in the database.
 *
 * - Wraps `name`/`version` into `{ workload: { name, version } }`
 * - Serializes {@link SecretRef} values to `"${global-secret:NAME}"` strings
 * - Applies defaults and validates against {@link WorkloadSchema}
 * - Throws {@link WorkloadParseError} on validation failures
 */
export function resolveWorkloadConfig(config: WorkloadConfig): Workload {
	const raw: Record<string, unknown> = {
		workload: { name: config.name, version: config.version },
		image: config.image,
		resources: config.resources,
	};

	if (config.network) {
		const network: Record<string, unknown> = { ...config.network };

		// Serialize SecretRef values in credentials
		if (config.network.credentials) {
			network.credentials = config.network.credentials.map((cred) => ({
				domain: cred.domain,
				headers: Object.fromEntries(
					Object.entries(cred.headers).map(([key, val]) => [
						key,
						isSecretRef(val) ? `\${global-secret:${val.name}}` : val,
					]),
				),
			}));
		}

		raw.network = network;
	}

	if (config.filesystem) raw.filesystem = config.filesystem;
	if (config.idle) raw.idle = config.idle;
	if (config.health) raw.health = config.health;
	if (config.entrypoint) raw.entrypoint = config.entrypoint;
	if (config.metadata) raw.metadata = config.metadata;

	Value.Default(WorkloadSchema, raw);
	checkImageMutualExclusivity(raw);
	checkHealthProbeMutualExclusivity(raw);
	checkCredentialConstraints(raw);

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
