import { describe, test, expect } from "bun:test";
import { LeaderElector } from "./leader-election";

describe("LeaderElector", () => {
  test("starts with isLeader false", () => {
    const elector = new LeaderElector({
      leaseName: "test-lease",
      leaseNamespace: "default",
      identity: "pod-1",
      leaseDurationSeconds: 15,
      renewDeadlineSeconds: 10,
      retryPeriodSeconds: 2,
      apiUrl: "http://localhost:8001",
      headers: {},
    });
    expect(elector.isLeader).toBe(false);
  });

  test("stop() prevents the loop from running", () => {
    const elector = new LeaderElector({
      leaseName: "test-lease",
      leaseNamespace: "default",
      identity: "pod-1",
      leaseDurationSeconds: 15,
      renewDeadlineSeconds: 10,
      retryPeriodSeconds: 2,
      apiUrl: "http://localhost:8001",
      headers: {},
    });
    elector.stop();
    expect(elector.isLeader).toBe(false);
  });
});
