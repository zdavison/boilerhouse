import { describe, test, expect } from "bun:test";
import type { BoilerhouseTrigger } from "./crd-types";
import { reconcileTrigger } from "./trigger-controller";

const API_VERSION = "boilerhouse.dev/v1alpha1" as const;

function makeTriggerCrd(
  name: string,
  type: BoilerhouseTrigger["spec"]["type"] = "webhook",
  overrides?: { deletionTimestamp?: string },
): BoilerhouseTrigger {
  return {
    apiVersion: API_VERSION,
    kind: "BoilerhouseTrigger",
    metadata: {
      name,
      namespace: "default",
      generation: 1,
      deletionTimestamp: overrides?.deletionTimestamp,
    },
    spec: {
      type,
      workloadRef: "my-workload",
    },
  };
}

describe("reconcileTrigger", () => {
  test("valid webhook trigger returns Active", async () => {
    const adapters = new Map<string, { stop: () => void }>();
    let startedName: string | undefined;

    const status = await reconcileTrigger(
      makeTriggerCrd("webhook-trigger"),
      {
        adapters,
        startAdapter: (name, _spec) => {
          startedName = name;
          return { stop: () => {} };
        },
      },
    );

    expect(status.phase).toBe("Active");
    expect(startedName).toBe("webhook-trigger");
    expect(adapters.has("webhook-trigger")).toBe(true);
  });

  test("deletion stops adapter", async () => {
    const adapters = new Map<string, { stop: () => void }>();
    let stopped = false;
    adapters.set("del-trigger", { stop: () => { stopped = true; } });

    const status = await reconcileTrigger(
      makeTriggerCrd("del-trigger", "webhook", {
        deletionTimestamp: new Date().toISOString(),
      }),
      { adapters },
    );

    expect(status.phase).toBeUndefined();
    expect(stopped).toBe(true);
    expect(adapters.has("del-trigger")).toBe(false);
  });

  test("update stops old adapter and starts new one", async () => {
    const adapters = new Map<string, { stop: () => void }>();
    let oldStopped = false;
    adapters.set("up-trigger", { stop: () => { oldStopped = true; } });

    const status = await reconcileTrigger(
      makeTriggerCrd("up-trigger"),
      {
        adapters,
        startAdapter: (_name, _spec) => ({ stop: () => {} }),
      },
    );

    expect(status.phase).toBe("Active");
    expect(oldStopped).toBe(true);
    expect(adapters.has("up-trigger")).toBe(true);
  });

  test("startAdapter error returns Error phase", async () => {
    const adapters = new Map<string, { stop: () => void }>();

    const status = await reconcileTrigger(
      makeTriggerCrd("err-trigger"),
      {
        adapters,
        startAdapter: () => { throw new Error("adapter failed"); },
      },
    );

    expect(status.phase).toBe("Error");
    expect(status.detail).toContain("adapter failed");
  });
});
