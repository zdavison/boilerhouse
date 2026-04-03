import { describe, test, expect } from "bun:test";
import { Controller } from "./controller";

describe("Controller", () => {
  test("processes queued items via reconcile", async () => {
    const reconciled: string[] = [];
    const controller = new Controller<{ metadata: { name: string } }>({
      name: "test",
      reconcile: async (item) => {
        reconciled.push(item.metadata.name);
      },
    });

    controller.enqueue({ metadata: { name: "item-1" } } as any);
    controller.enqueue({ metadata: { name: "item-2" } } as any);

    // Let the queue drain
    await controller.processOnce();
    await controller.processOnce();

    expect(reconciled).toEqual(["item-1", "item-2"]);
  });

  test("requeues on error with backoff", async () => {
    let attempts = 0;
    const controller = new Controller<{ metadata: { name: string } }>({
      name: "test",
      reconcile: async () => {
        attempts++;
        if (attempts === 1) throw new Error("transient");
      },
    });

    controller.enqueue({ metadata: { name: "retry-me" } } as any);
    await controller.processOnce(); // fails, requeues with backoff
    expect(attempts).toBe(1);

    // Item is requeued but in backoff — queue is non-empty but not yet ready
    expect(controller.queueDepth).toBe(1);

    // Force the item's nextAttempt to now so we can process it
    (controller as any).queue[0].nextAttempt = Date.now();
    await controller.processOnce(); // retries
    expect(attempts).toBe(2);
  });

  test("does not deduplicate items with same name but different namespace", async () => {
    const reconciled: string[] = [];
    const controller = new Controller<{ metadata: { name: string; namespace?: string } }>({
      name: "test",
      reconcile: async (item) => {
        reconciled.push(`${item.metadata.namespace}/${item.metadata.name}`);
      },
    });

    controller.enqueue({ metadata: { name: "item-1", namespace: "ns-a" } } as any);
    controller.enqueue({ metadata: { name: "item-1", namespace: "ns-b" } } as any);

    await controller.processOnce();
    await controller.processOnce();

    expect(reconciled).toContain("ns-a/item-1");
    expect(reconciled).toContain("ns-b/item-1");
    expect(reconciled.length).toBe(2);
  });

  test("deduplicates items with same name", async () => {
    const reconciled: string[] = [];
    const controller = new Controller<{ metadata: { name: string }; value?: string }>({
      name: "test",
      reconcile: async (item) => {
        reconciled.push((item as any).value ?? item.metadata.name);
      },
    });

    controller.enqueue({ metadata: { name: "item-1" }, value: "first" } as any);
    controller.enqueue({ metadata: { name: "item-1" }, value: "second" } as any);

    await controller.processOnce();
    await controller.processOnce();

    // Only one item should be processed (deduplicated), the second replaces the first
    expect(reconciled).toEqual(["second"]);
    expect(reconciled.length).toBe(1);
  });
});
