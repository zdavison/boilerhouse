import { Type, type Static } from "@sinclair/typebox";
import { createMachine, type TransitionMap } from "./state-machine";

// ── Schemas ─────────────────────────────────────────────────────────────────

export const TenantStatusSchema = Type.Union([
	Type.Literal("idle"),
	Type.Literal("claiming"),
	Type.Literal("active"),
	Type.Literal("releasing"),
	Type.Literal("released"),
]);

export const TenantEventSchema = Type.Union([
	Type.Literal("claim"),
	Type.Literal("claimed"),
	Type.Literal("claim_failed"),
	Type.Literal("release"),
	Type.Literal("hibernated"),
	Type.Literal("destroyed"),
]);

// ── Types ───────────────────────────────────────────────────────────────────

export type TenantStatus = Static<typeof TenantStatusSchema>;
export type TenantEvent = Static<typeof TenantEventSchema>;

export const TENANT_STATUSES = [
	"idle",
	"claiming",
	"active",
	"releasing",
	"released",
] as const satisfies readonly TenantStatus[];

export const TENANT_EVENTS = [
	"claim",
	"claimed",
	"claim_failed",
	"release",
	"hibernated",
	"destroyed",
] as const satisfies readonly TenantEvent[];

// ── Machine ─────────────────────────────────────────────────────────────────

const transitions: TransitionMap<TenantStatus, TenantEvent> = {
	idle: { claim: "claiming" },
	claiming: { claimed: "active", claim_failed: "idle" },
	active: { release: "releasing" },
	releasing: { hibernated: "released", destroyed: "idle" },
	released: { claim: "claiming" },
};

const tenantMachine = createMachine<TenantStatus, TenantEvent>("tenant", {
	transitions,
});

/**
 * Applies an event to the current tenant status, returning the new status.
 * Throws {@link InvalidTransitionError} if the transition is not allowed.
 */
export function tenantTransition(
	current: TenantStatus,
	event: TenantEvent,
): TenantStatus {
	return tenantMachine.transition(current, event);
}
