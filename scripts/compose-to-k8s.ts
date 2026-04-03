/**
 * Reads docker-compose.yml via `docker compose config --format json`
 * and generates Kubernetes Deployment + Service manifests for
 * functional infrastructure dependencies.
 *
 * Usage: bun run scripts/compose-to-k8s.ts
 * Output: YAML to stdout, pipe to `kubectl apply -f -`
 */

// ── Types matching `docker compose config --format json` ────────────────

interface ComposePort {
  mode: string;
  target: number;
  published: string;
  protocol: string;
}

interface ComposeVolume {
  type: string;
  source: string;
  target: string;
}

interface ComposeService {
  image: string;
  command: string[] | null;
  entrypoint: string[] | null;
  environment?: Record<string, string>;
  ports?: ComposePort[];
  volumes?: ComposeVolume[];
  depends_on?: Record<string, unknown>;
}

interface ComposeConfig {
  services: Record<string, ComposeService>;
}

// ── Configuration ───────────────────────────────────────────────────────

/** Services to exclude from k8s translation (observability + utility). */
const EXCLUDE = new Set(["prometheus", "tempo", "grafana", "minio-init"]);

/**
 * Map of init-container services → the parent service they attach to.
 * Key: compose service name that becomes an init container.
 * Value: compose service name it should be attached to.
 */
const INIT_CONTAINERS: Record<string, string> = {
  "minio-init": "minio",
};

// ── Manifest generation ─────────────────────────────────────────────────

function renderEnv(env: Record<string, string>): string {
  return Object.entries(env)
    .map(([k, v]) => `        - name: ${k}\n          value: ${JSON.stringify(v)}`)
    .join("\n");
}

function renderPorts(ports: ComposePort[], indent: string): string {
  return ports
    .map((p) => `${indent}- containerPort: ${p.target}`)
    .join("\n");
}

function renderCommand(cmd: string[]): string {
  return cmd.map((c) => `        - ${JSON.stringify(c)}`).join("\n");
}

function buildInitContainer(svc: ComposeService, name: string, parentVolumes: ComposeVolume[]): string {
  // Rewrite entrypoint to replace compose service name with localhost
  // (init container runs in same pod as parent)
  const entrypoint = svc.entrypoint
    ? svc.entrypoint.map((s) => s.replace(/http:\/\/minio:(\d+)/g, "http://localhost:$1"))
    : null;

  const lines = [
    `      - name: ${name}`,
    `        image: ${svc.image}`,
  ];

  if (entrypoint) {
    lines.push(`        command:`);
    for (const arg of entrypoint) {
      lines.push(`        - ${JSON.stringify(arg)}`);
    }
  }

  // Mount same volumes as parent so init can access the data dir
  if (parentVolumes.length > 0) {
    lines.push(`        volumeMounts:`);
    for (const vol of parentVolumes) {
      if (vol.type === "volume") {
        lines.push(`        - name: ${vol.source}`);
        lines.push(`          mountPath: ${vol.target}`);
      }
    }
  }

  return lines.join("\n");
}

function buildDeployment(
  name: string,
  svc: ComposeService,
  initSvc?: { name: string; svc: ComposeService },
): string {
  const metaLabels = `app: ${name}\n    boilerhouse.dev/infra: "true"`;
  const podLabels = `app: ${name}\n        boilerhouse.dev/infra: "true"`;
  const matchLabels = `app: ${name}`;
  const volumes = svc.volumes ?? [];
  const namedVolumes = volumes.filter((v) => v.type === "volume");

  let containerSpec = `      containers:\n      - name: ${name}\n        image: ${svc.image}`;

  if (svc.command) {
    containerSpec += `\n        command:\n${renderCommand(svc.command)}`;
  }

  if (svc.ports && svc.ports.length > 0) {
    containerSpec += `\n        ports:\n${renderPorts(svc.ports, "        ")}`;
  }

  if (svc.environment && Object.keys(svc.environment).length > 0) {
    containerSpec += `\n        env:\n${renderEnv(svc.environment)}`;
  }

  if (namedVolumes.length > 0) {
    containerSpec += `\n        volumeMounts:`;
    for (const vol of namedVolumes) {
      containerSpec += `\n        - name: ${vol.source}\n          mountPath: ${vol.target}`;
    }
  }

  let initSpec = "";
  if (initSvc) {
    initSpec = `\n      initContainers:\n${buildInitContainer(initSvc.svc, initSvc.name, namedVolumes)}`;
  }

  let volumeSpec = "";
  if (namedVolumes.length > 0) {
    volumeSpec = `\n      volumes:`;
    for (const vol of namedVolumes) {
      volumeSpec += `\n      - name: ${vol.source}\n        emptyDir: {}`;
    }
  }

  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
  labels:
    ${metaLabels}
spec:
  replicas: 1
  selector:
    matchLabels:
      ${matchLabels}
  template:
    metadata:
      labels:
        ${podLabels}
    spec:${initSpec}
${containerSpec}${volumeSpec}`;
}

function buildService(name: string, ports: ComposePort[]): string {
  const labels = `app: ${name}\n    boilerhouse.dev/infra: "true"`;
  const portLines = ports
    .map(
      (p) =>
        `    - port: ${p.target}\n      targetPort: ${p.target}\n      protocol: ${p.protocol.toUpperCase()}`,
    )
    .join("\n");

  return `apiVersion: v1
kind: Service
metadata:
  name: ${name}
  labels:
    ${labels}
spec:
  selector:
    app: ${name}
  ports:
${portLines}`;
}

// ── Public API ──────────────────────────────────────────────────────────

export function generateManifests(config: ComposeConfig): string {
  const docs: string[] = [];

  // Collect init container services
  const initContainerMap = new Map<string, { name: string; svc: ComposeService }>();
  for (const [initName, parentName] of Object.entries(INIT_CONTAINERS)) {
    const initSvc = config.services[initName];
    if (initSvc) {
      initContainerMap.set(parentName, { name: initName, svc: initSvc });
    }
  }

  for (const [name, svc] of Object.entries(config.services)) {
    if (EXCLUDE.has(name)) continue;

    const initSvc = initContainerMap.get(name);
    docs.push(buildDeployment(name, svc, initSvc));

    if (svc.ports && svc.ports.length > 0) {
      docs.push(buildService(name, svc.ports));
    }
  }

  return docs.join("\n---\n");
}

// ── CLI entrypoint ──────────────────────────────────────────────────────

async function main() {
  const proc = Bun.spawn(["docker", "compose", "config", "--format", "json"], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text();
    console.error("docker compose config failed:", stderr);
    process.exit(1);
  }

  const config: ComposeConfig = JSON.parse(stdout);
  console.log(generateManifests(config));
}

// Only run main when executed directly, not when imported for tests
if (import.meta.main) {
  main();
}
