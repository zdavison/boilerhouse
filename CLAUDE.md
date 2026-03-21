# Boilerhouse

NOT-RELEASED

## Testing

Tests are organized into tiers. Only unit tests run by default.

### Unit tests

```sh
bun test
```

Runs `bun test packages/ apps/ workloads/` — scoped to workspace
dirs so that `tests/` (integration, e2e, security) is excluded.

### Integration tests

Live in `tests/integration/`. Require live infrastructure.

**Podman** — requires podmand socket (default `/var/run/boilerhouse/podman.sock`):

```sh
BOILERHOUSE_CRIU_AVAILABLE=true bun test tests/integration/podman.integration.test.ts --timeout 60000
```

**Kubernetes** — requires minikube with profile `boilerhouse-test`
(`bunx kadai run minikube` to set up):

```sh
bun test tests/integration/kubernetes.integration.test.ts --timeout 60000
```

### E2E tests

Live in `tests/e2e/`. Run via kadai (`bunx kadai run e2e`) or directly:

```sh
# All detected runtimes (fake + podman + kubernetes)
BOILERHOUSE_CRIU_AVAILABLE=true bun test tests/e2e/ --timeout 120000

# Filter to specific runtimes
BOILERHOUSE_E2E_RUNTIMES=fake bun test tests/e2e/ --timeout 120000
BOILERHOUSE_E2E_RUNTIMES=podman bun test tests/e2e/ --timeout 120000
```

### Security tests

Live in `tests/security/`. Run via kadai:

- `bunx kadai run security` — Nuclei red-team templates against the API
- `bunx kadai run security-breakout` — CDK container escape scan

### Test structure

```
packages/            *.test.ts                unit tests (bun test)
apps/                *.test.ts                unit tests (bun test)
tests/integration/   *.integration.test.ts    integration tests (live infra)
tests/e2e/           *.e2e.test.ts            E2E tests (kadai or manual)
tests/security/      scripts                  security scans (kadai only)
```
