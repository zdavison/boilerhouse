import type {
  BoilerhouseTrigger,
  BoilerhouseTriggerStatus,
} from "./crd-types";

export interface TriggerControllerDeps {
  adapters: Map<string, { stop: () => void }>;
  startAdapter?: (name: string, spec: BoilerhouseTrigger["spec"]) => { stop: () => void };
}

/**
 * Reconciles a BoilerhouseTrigger CRD.
 * Manages adapter lifecycle: starts/stops adapters based on CRD state.
 */
export async function reconcileTrigger(
  crd: BoilerhouseTrigger,
  deps: TriggerControllerDeps,
): Promise<BoilerhouseTriggerStatus> {
  const name = crd.metadata.name;

  try {
    // 1. Deletion: stop adapter and return
    if (crd.metadata.deletionTimestamp) {
      const existing = deps.adapters.get(name);
      if (existing) {
        existing.stop();
        deps.adapters.delete(name);
      }
      return {};
    }

    // 2. Stop existing adapter if updating
    const existing = deps.adapters.get(name);
    if (existing) {
      existing.stop();
      deps.adapters.delete(name);
    }

    // 3. Start new adapter if callback provided
    if (deps.startAdapter) {
      const adapter = deps.startAdapter(name, crd.spec);
      deps.adapters.set(name, adapter);
    }

    return { phase: "Active" };
  } catch (err) {
    return {
      phase: "Error",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
