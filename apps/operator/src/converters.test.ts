import { describe, test, expect } from "bun:test";
import { crdToWorkload } from "./converters";
import type { BoilerhouseWorkloadSpec } from "./crd-types";

describe("crdToWorkload", () => {
  test("converts minimal CRD spec to Workload", () => {
    const spec: BoilerhouseWorkloadSpec = {
      version: "1.0.0",
      image: { ref: "test:latest" },
      resources: { vcpus: 1, memoryMb: 256, diskGb: 2 },
    };

    const workload = crdToWorkload("my-agent", spec);

    expect(workload.workload.name).toBe("my-agent");
    expect(workload.workload.version).toBe("1.0.0");
    expect(workload.image.ref).toBe("test:latest");
    expect(workload.resources.vcpus).toBe(1);
    expect(workload.resources.memory_mb).toBe(256);
    expect(workload.network.access).toBe("none");
  });

  test("converts full CRD spec with all fields", () => {
    const spec: BoilerhouseWorkloadSpec = {
      version: "2.0.0",
      image: { ref: "agent:v2" },
      resources: { vcpus: 4, memoryMb: 1024, diskGb: 20 },
      network: {
        access: "restricted",
        expose: [{ guest: 8080 }],
        allowlist: ["api.example.com"],
        websocket: "/ws",
      },
      filesystem: {
        overlayDirs: ["/data"],
        encryptOverlays: true,
      },
      idle: {
        timeoutSeconds: 300,
        action: "hibernate",
        watchDirs: ["/data"],
      },
      health: {
        intervalSeconds: 10,
        unhealthyThreshold: 3,
        httpGet: { path: "/health", port: 8080 },
      },
      entrypoint: {
        cmd: "/app/start",
        args: ["--verbose"],
        env: { LOG_LEVEL: "debug" },
        workdir: "/app",
      },
    };

    const workload = crdToWorkload("full-agent", spec);

    expect(workload.network.access).toBe("restricted");
    expect(workload.network.expose).toEqual([{ guest: 8080 }]);
    expect(workload.network.allowlist).toEqual(["api.example.com"]);
    expect(workload.filesystem?.overlay_dirs).toEqual(["/data"]);
    expect(workload.filesystem?.encrypt_overlays).toBe(true);
    expect(workload.idle?.timeout_seconds).toBe(300);
    expect(workload.idle?.action).toBe("hibernate");
    expect(workload.health?.http_get).toEqual({ path: "/health", port: 8080 });
    expect(workload.entrypoint?.cmd).toBe("/app/start");
  });
});
