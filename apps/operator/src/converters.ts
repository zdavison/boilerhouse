import type { Workload } from "@boilerhouse/core";
import type { BoilerhouseWorkloadSpec } from "./crd-types";

/**
 * Converts a BoilerhouseWorkload CRD spec into the internal Workload type
 * used by domain managers.
 *
 * CRD uses camelCase; internal Workload uses snake_case for some fields.
 */
export function crdToWorkload(name: string, spec: BoilerhouseWorkloadSpec): Workload {
  return {
    workload: { name, version: spec.version },
    image: { ref: spec.image.ref },
    resources: {
      vcpus: spec.resources?.vcpus ?? 1,
      memory_mb: spec.resources?.memoryMb ?? 512,
      disk_gb: spec.resources?.diskGb ?? 2,
    },
    network: {
      access: spec.network?.access ?? "none",
      // CRD expose only has guest; cast to satisfy internal type
      expose: spec.network?.expose as Workload["network"]["expose"],
      allowlist: spec.network?.allowlist,
      websocket: spec.network?.websocket,
    },
    filesystem: spec.filesystem
      ? {
          overlay_dirs: spec.filesystem.overlayDirs ?? [],
          encrypt_overlays: spec.filesystem.encryptOverlays ?? false,
        }
      : undefined,
    idle: {
      timeout_seconds: spec.idle?.timeoutSeconds,
      action: spec.idle?.action ?? "hibernate",
      watch_dirs: spec.idle?.watchDirs,
    },
    health: spec.health
      ? {
          interval_seconds: spec.health.intervalSeconds ?? 10,
          unhealthy_threshold: spec.health.unhealthyThreshold ?? 3,
          http_get: spec.health.httpGet,
          exec: spec.health.exec,
        }
      : undefined,
    entrypoint: spec.entrypoint
      ? {
          cmd: spec.entrypoint.cmd ?? "",
          args: spec.entrypoint.args,
          env: spec.entrypoint.env,
          workdir: spec.entrypoint.workdir,
        }
      : undefined,
  };
}
