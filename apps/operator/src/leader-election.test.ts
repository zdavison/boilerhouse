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

  test("checkRenewDeadline steps down if deadline exceeded", () => {
    let stopped = false;
    const elector = new LeaderElector({
      leaseName: "test-lease",
      leaseNamespace: "default",
      identity: "pod-1",
      leaseDurationSeconds: 15,
      renewDeadlineSeconds: 10,
      retryPeriodSeconds: 2,
      apiUrl: "http://localhost:8001",
      headers: {},
      onStoppedLeading: () => { stopped = true; },
    });

    // Force isLeader=true and lastRenewMs to be well past deadline
    (elector as any)._isLeader = true;
    (elector as any).lastRenewMs = Date.now() - 11_000; // 11s ago, deadline is 10s

    elector.checkRenewDeadline();

    expect(stopped).toBe(true);
    expect(elector.isLeader).toBe(false);
  });

  test("checkRenewDeadline does not step down within deadline", () => {
    let stopped = false;
    const elector = new LeaderElector({
      leaseName: "test-lease",
      leaseNamespace: "default",
      identity: "pod-1",
      leaseDurationSeconds: 15,
      renewDeadlineSeconds: 10,
      retryPeriodSeconds: 2,
      apiUrl: "http://localhost:8001",
      headers: {},
      onStoppedLeading: () => { stopped = true; },
    });

    (elector as any)._isLeader = true;
    (elector as any).lastRenewMs = Date.now() - 5_000; // 5s ago, deadline is 10s

    elector.checkRenewDeadline();

    expect(stopped).toBe(false);
    expect(elector.isLeader).toBe(true);
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
