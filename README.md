# Boilerhouse

Multi-tenant container orchestration for building SaaS products, built for AI agents first.

Some use cases:
  - Giving users their own persistent AI agent container that only exists while theyre using it.
  - Slack bot that runs AI agents to automatically debug alerts.
  - On-demand coding agents.
  - 

## Features

- Spin up containers on-demand in response to **Triggers** (e.g. Telegram, Slack, Webhook, Cron)
- Spin down those container when idle.
- Persist tenant data and restore it on next claim.
- Maintain warm container pools so tenants can claim containers as quickly as possible.
- Isolate containers such that users can run whatever you want on them, safely.

## Quick Start

<!-- WRITE: minimal steps to get running — prerequisites, install, start API, register workload, claim instance -->

## Documentation

Full documentation at the [Boilerhouse docs site](https://zdavison.github.io/boilerhouse/).

## Project Structure

<!-- WRITE: brief overview of monorepo layout -->

```
packages/           Shared libraries (core, db, runtimes, triggers, ...)
apps/               Applications (api, cli, dashboard, trigger-gateway, docs)
workloads/          Example workload definitions
tests/              Integration, E2E, and security tests
deploy/             Prometheus, Grafana, Tempo configs
```

## Development

<!-- WRITE: clone, bun install, run dev, run tests -->

## Configuration

<!-- WRITE: key env vars table or link to docs -->

## Deployment

<!-- WRITE: brief summary of deployment options — binary, Docker, systemd -->

## License

[Business Source License 1.1](LICENSE.md)
