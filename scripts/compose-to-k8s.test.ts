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

  test("excludes minio-init as standalone deployment", () => {
    const deploymentNames = [...manifests.matchAll(/name: (\S+)\n\s+labels:/g)].map(m => m[1]);
    expect(deploymentNames).not.toContain("minio-init");
  });

  test("generates redis deployment and service", () => {
    expect(manifests).toContain("image: redis:7-alpine");
    expect(manifests).toContain("name: redis");
    expect(manifests).toContain("containerPort: 6379");
    expect(manifests).toContain("kind: Deployment");
    expect(manifests).toContain("kind: Service");
  });

  test("generates minio deployment with init container", () => {
    expect(manifests).toContain("image: minio/minio:latest");
    expect(manifests).toContain("initContainers:");
    expect(manifests).toContain("image: minio/mc:latest");
    expect(manifests).toContain("name: minio-init");
  });

  test("minio init container connects to localhost not minio service name", () => {
    expect(manifests).toContain("http://localhost:9000");
    expect(manifests).not.toContain("http://minio:9000");
  });

  test("minio has emptyDir volume for /data", () => {
    expect(manifests).toContain("emptyDir: {}");
    expect(manifests).toContain("mountPath: /data");
  });

  test("minio has env vars", () => {
    expect(manifests).toContain("MINIO_ROOT_USER");
    expect(manifests).toContain("MINIO_ROOT_PASSWORD");
  });

  test("minio deployment has command", () => {
    expect(manifests).toContain('- "server"');
    expect(manifests).toContain('- "/data"');
  });

  test("services use ClusterIP (default)", () => {
    expect(manifests).not.toContain("NodePort");
    expect(manifests).not.toContain("LoadBalancer");
  });

  test("output is valid multi-document YAML with separators", () => {
    const docs = manifests.split("---").filter(d => d.trim().length > 0);
    expect(docs.length).toBe(4);
  });

  test("all resources have boilerhouse.dev/infra label", () => {
    const matches = manifests.match(/boilerhouse\.dev\/infra: "true"/g);
    // 6: 2 deployment meta + 2 pod template + 2 service meta
    expect(matches?.length).toBe(6);
  });
});
