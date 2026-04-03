import { describe, test, expect } from "bun:test";
import { generateManifests } from "./compose-to-k8s";

const COMPOSE_CONFIG = {
  services: {
    redis: {
      image: "redis:7-alpine",
      command: null,
      entrypoint: null,
      environment: {},
      ports: [{ mode: "ingress", target: 6379, published: "6379", protocol: "tcp" }],
    },
    minio: {
      image: "minio/minio:latest",
      command: ["server", "/data", "--console-address", ":9001"],
      entrypoint: null,
      environment: { MINIO_ROOT_USER: "minioadmin", MINIO_ROOT_PASSWORD: "minioadmin" },
      ports: [
        { mode: "ingress", target: 9000, published: "9000", protocol: "tcp" },
        { mode: "ingress", target: 9001, published: "9001", protocol: "tcp" },
      ],
      volumes: [{ type: "volume", source: "minio-data", target: "/data", volume: {} }],
    },
    "minio-init": {
      image: "minio/mc:latest",
      command: null,
      entrypoint: ["/bin/sh", "-c", "sleep 2; mc alias set local http://minio:9000 minioadmin minioadmin; mc mb --ignore-existing local/boilerhouse; echo 'Bucket ready';"],
      depends_on: { minio: { condition: "service_started", required: true } },
    },
    prometheus: {
      image: "prom/prometheus:latest",
      command: ["--config.file=/etc/prometheus/prometheus.yml"],
      entrypoint: null,
      ports: [{ mode: "ingress", target: 9090, published: "9090", protocol: "tcp" }],
    },
    grafana: {
      image: "grafana/grafana:latest",
      entrypoint: null,
      command: null,
      ports: [{ mode: "ingress", target: 3000, published: "3003", protocol: "tcp" }],
    },
    tempo: {
      image: "grafana/tempo:2.7.2",
      entrypoint: null,
      command: ["-config.file=/etc/tempo/tempo.yml"],
      ports: [{ mode: "ingress", target: 4318, published: "4318", protocol: "tcp" }],
    },
  },
};

describe("generateManifests", () => {
  const manifests = generateManifests(COMPOSE_CONFIG);

  test("excludes observability services", () => {
    expect(manifests).not.toContain("prometheus");
    expect(manifests).not.toContain("grafana");
    expect(manifests).not.toContain("tempo");
  });

  test("generates redis deployment and service", () => {
    expect(manifests).toContain("image: redis:7-alpine");
    expect(manifests).toContain("name: redis");
    expect(manifests).toContain("containerPort: 6379");
    expect(manifests).toContain("kind: Deployment");
    expect(manifests).toContain("kind: Service");
  });

  test("generates minio-init as a Job (not init container)", () => {
    expect(manifests).toContain("kind: Job");
    expect(manifests).toContain("name: minio-init");
    expect(manifests).toContain("image: minio/mc:latest");
    // Job is a separate pod — reaches minio via k8s Service DNS
    expect(manifests).toContain("http://minio:9000");
    expect(manifests).toContain("restartPolicy: OnFailure");
    // Should NOT be an init container on the minio Deployment
    expect(manifests).not.toContain("initContainers:");
  });

  test("minio has emptyDir volume for /data", () => {
    expect(manifests).toContain("emptyDir: {}");
    expect(manifests).toContain("mountPath: /data");
  });

  test("minio has env vars", () => {
    expect(manifests).toContain("MINIO_ROOT_USER");
    expect(manifests).toContain("MINIO_ROOT_PASSWORD");
  });

  test("minio deployment has args (compose command maps to k8s args)", () => {
    // compose `command` → k8s `args` (preserves image entrypoint)
    expect(manifests).toContain("args:");
    expect(manifests).toContain('- "server"');
    expect(manifests).toContain('- "/data"');
  });

  test("services use ClusterIP (default)", () => {
    expect(manifests).not.toContain("NodePort");
    expect(manifests).not.toContain("LoadBalancer");
  });

  test("multi-port services have port names", () => {
    // k8s requires named ports when a Service has >1 port
    expect(manifests).toContain("name: minio-9000");
    expect(manifests).toContain("name: minio-9001");
  });

  test("output is valid multi-document YAML with separators", () => {
    const docs = manifests.split("---").filter(d => d.trim().length > 0);
    // redis: deployment + service, minio: deployment + service, minio-init: job
    expect(docs.length).toBe(5);
  });

  test("all resources have boilerhouse.dev/infra label", () => {
    const matches = manifests.match(/boilerhouse\.dev\/infra: "true"/g);
    // 2 deployment meta + 2 pod template + 2 service meta + 1 job meta + 1 job pod template
    expect(matches?.length).toBe(8);
  });
});
