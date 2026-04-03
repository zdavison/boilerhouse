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

/** Services to exclude from k8s translation (observability). */
const EXCLUDE = new Set(["prometheus", "tempo", "grafana"]);

/**
 * Services that become k8s Jobs instead of Deployments.
 * These are one-shot setup tasks (e.g. bucket creation) that depend on
 * another service being reachable via its k8s Service DNS name.
 */
const JOBS = new Set(["minio-init"]);

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

function buildDeployment(name: string, svc: ComposeService): string {
  const metaLabels = `app: ${name}\n    boilerhouse.dev/infra: "true"`;
  const podLabels = `app: ${name}\n        boilerhouse.dev/infra: "true"`;
  const matchLabels = `app: ${name}`;
  const volumes = svc.volumes ?? [];
  const namedVolumes = volumes.filter((v) => v.type === "volume");

  let containerSpec = `      containers:\n      - name: ${name}\n        image: ${svc.image}`;

  // Docker compose: entrypoint → k8s command, command → k8s args
  if (svc.entrypoint) {
    containerSpec += `\n        command:\n${renderCommand(svc.entrypoint)}`;
  }
  if (svc.command) {
    containerSpec += `\n        args:\n${renderCommand(svc.command)}`;
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
    spec:
${containerSpec}${volumeSpec}`;
}

function buildService(name: string, ports: ComposePort[]): string {
  const labels = `app: ${name}\n    boilerhouse.dev/infra: "true"`;
  const needsNames = ports.length > 1;
  const portLines = ports
    .map(
      (p) => {
        const nameLine = needsNames ? `\n      name: ${name}-${p.target}` : "";
        return `    - port: ${p.target}\n      targetPort: ${p.target}\n      protocol: ${p.protocol.toUpperCase()}${nameLine}`;
      },
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

function buildJob(name: string, svc: ComposeService): string {
  const metaLabels = `app: ${name}\n    boilerhouse.dev/infra: "true"`;
  const podLabels = `app: ${name}\n        boilerhouse.dev/infra: "true"`;

  // Use entrypoint or command for the container command
  const cmd = svc.entrypoint ?? svc.command;
  let cmdSpec = "";
  if (cmd) {
    cmdSpec = `\n        command:\n${renderCommand(cmd)}`;
  }

  return `apiVersion: batch/v1
kind: Job
metadata:
  name: ${name}
  labels:
    ${metaLabels}
spec:
  backoffLimit: 5
  template:
    metadata:
      labels:
        ${podLabels}
    spec:
      restartPolicy: OnFailure
      containers:
      - name: ${name}
        image: ${svc.image}${cmdSpec}`;
}

// ── Public API ──────────────────────────────────────────────────────────

export function generateManifests(config: ComposeConfig): string {
  const docs: string[] = [];

  for (const [name, svc] of Object.entries(config.services)) {
    if (EXCLUDE.has(name)) continue;

    if (JOBS.has(name)) {
      docs.push(buildJob(name, svc));
      continue;
    }

    docs.push(buildDeployment(name, svc));

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
