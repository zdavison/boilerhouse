import type { ContainerCreateSpec } from "@boilerhouse/runtime-podman";

export class PolicyViolationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PolicyViolationError";
	}
}

export interface ValidateOptions {
	/** Directories from which bind mounts are permitted (read-only). */
	allowedBindSources?: string[];
}

/**
 * Validates a container create spec against the daemon's security policy.
 * Throws `PolicyViolationError` if any rule is violated.
 *
 * Returns a sanitized copy of the spec with enforced labels and privileged=false.
 */
export function validateContainerSpec(spec: ContainerCreateSpec, options?: ValidateOptions): ContainerCreateSpec {
	if (spec.privileged === true) {
		throw new PolicyViolationError("Privileged containers are not allowed");
	}

	if (spec.netns?.nsmode === "host") {
		throw new PolicyViolationError("Host network namespace is not allowed");
	}

	if (spec.portmappings) {
		for (const pm of spec.portmappings) {
			if (pm.host_port !== 0) {
				throw new PolicyViolationError(
					`Fixed host_port ${pm.host_port} is not allowed — use 0 for ephemeral allocation`,
				);
			}
		}
	}

	// Require capabilities to be dropped
	if (!spec.cap_drop || !spec.cap_drop.includes("ALL")) {
		throw new PolicyViolationError(
			'cap_drop must include "ALL" — capabilities must be explicitly dropped',
		);
	}

	// Require no-new-privileges
	if (spec.no_new_privileges !== true) {
		throw new PolicyViolationError(
			"no_new_privileges must be enabled",
		);
	}

	if (spec.mounts) {
		const allowedPrefixes = options?.allowedBindSources ?? [];
		for (const mount of spec.mounts) {
			if (mount.type === "bind") {
				const source = mount.source ?? "";
				const allowed = allowedPrefixes.some((prefix) => source.startsWith(prefix + "/"));
				if (!allowed) {
					throw new PolicyViolationError(
						`Bind mount from ${source || "(no source)"} to ${mount.destination} is not allowed`,
					);
				}
			}
		}
	}

	return {
		...spec,
		privileged: false,
		no_new_privileges: true,
		labels: {
			...spec.labels,
			"managed-by": "boilerhouse-podmand",
		},
	};
}
