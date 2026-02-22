/**
 * Lightweight pure FSM infrastructure.
 *
 * Each entity type (instance, node, tenant, snapshot) defines its own
 * `TransitionMap` and optionally `Guard`s, then calls `createMachine`
 * to get a `{ transition, can }` object.
 */

/** Maps each state to the events it accepts and the resulting state. */
export type TransitionMap<S extends string, E extends string> = Record<
	S,
	Partial<Record<E, S>>
>;

/**
 * Optional guard that runs before a transition is applied.
 * Return `true` to allow, `false` to deny, or a `string` reason to deny with a message.
 */
export type Guard<S extends string, E extends string, Ctx> = (
	current: S,
	event: E,
	ctx: Ctx | undefined,
) => boolean | string;

export interface MachineConfig<S extends string, E extends string, Ctx> {
	transitions: TransitionMap<S, E>;
	guards?: Guard<S, E, Ctx>[];
}

export class InvalidTransitionError extends Error {
	constructor(
		public readonly entity: string,
		public readonly status: string,
		public readonly event: string,
		public readonly reason?: string,
	) {
		const base = `${entity}: cannot apply '${event}' in status '${status}'`;
		super(reason ? `${base} (${reason})` : base);
		this.name = "InvalidTransitionError";
	}
}

export interface Machine<S extends string, E extends string, Ctx> {
	/** Apply event to current state, returning the new state. Throws on invalid transition. */
	transition(current: S, event: E, ctx?: Ctx): S;
	/** Check whether a transition exists in the map (ignores guards). */
	can(current: S, event: E): boolean;
}

/**
 * Creates a pure state machine for the given entity.
 *
 * Event naming convention used throughout:
 * - **Commands** (imperative): trigger an operation — `hibernate`, `destroy`, `restore`, `claim`, `release`, `expire`, `delete`, `retry`
 * - **Results** (past tense): signal that an operation completed — `started`, `destroyed`, `created`, `failed`, `claimed`, `claim_failed`, `hibernated`
 *
 * This two-phase pattern (`command` → intermediate state → `result`) models
 * async operations: the command begins the work and the result confirms it.
 *
 * @param entity - Name used in error messages (e.g. "instance", "node")
 * @param config - Transition map and optional guards
 */
export function createMachine<
	S extends string,
	E extends string,
	Ctx = undefined,
>(entity: string, config: MachineConfig<S, E, Ctx>): Machine<S, E, Ctx> {
	const { transitions, guards } = config;

	return {
		transition(current: S, event: E, ctx?: Ctx): S {
			const next = transitions[current]?.[event];
			if (next === undefined) {
				throw new InvalidTransitionError(entity, current, event);
			}

			if (guards) {
				for (const guard of guards) {
					const result = guard(current, event, ctx);
					if (result === false) {
						throw new InvalidTransitionError(
							entity,
							current,
							event,
						);
					}
					if (typeof result === "string") {
						throw new InvalidTransitionError(
							entity,
							current,
							event,
							result,
						);
					}
				}
			}

			return next;
		},

		can(current: S, event: E): boolean {
			return transitions[current]?.[event] !== undefined;
		},
	};
}
