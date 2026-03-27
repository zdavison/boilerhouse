import { Type, type Static } from "@sinclair/typebox";
import { createMachine, type TransitionMap } from "./state-machine";

export const ClaimStatusSchema = Type.Union([
    Type.Literal("creating"),
    Type.Literal("active"),
    Type.Literal("releasing"),
]);

export const ClaimEventSchema = Type.Union([
    Type.Literal("created"),
    Type.Literal("release"),
    Type.Literal("recover"),
]);

export type ClaimStatus = Static<typeof ClaimStatusSchema>;
export type ClaimEvent = Static<typeof ClaimEventSchema>;

export const CLAIM_STATUSES = [
    "creating",
    "active",
    "releasing",
] as const satisfies readonly ClaimStatus[];

export const CLAIM_EVENTS = [
    "created",
    "release",
    "recover",
] as const satisfies readonly ClaimEvent[];

const transitions: TransitionMap<ClaimStatus, ClaimEvent> = {
    creating: { created: "active" },
    active: { release: "releasing" },
    releasing: { recover: "active" },
};

const claimMachine = createMachine<ClaimStatus, ClaimEvent>("claim", { transitions });

export function claimTransition(current: ClaimStatus, event: ClaimEvent): ClaimStatus {
    return claimMachine.transition(current, event);
}

export function canClaimTransition(current: ClaimStatus, event: ClaimEvent): boolean {
    return claimMachine.can(current, event);
}
