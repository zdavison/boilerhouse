import { Elysia, t } from "elysia";
import { eq } from "drizzle-orm";
import { triggers, workloads } from "@boilerhouse/db";
import { generateTriggerId, type TriggerId, InvalidTransitionError } from "@boilerhouse/core";
import type { RouteDeps } from "./deps";
import type { TenantId } from "@boilerhouse/core";

const TenantMappingSchema = t.Union([
	t.Object({ static: t.String({ minLength: 1 }) }),
	t.Object({
		fromField: t.String({ minLength: 1 }),
		prefix: t.Optional(t.String()),
	}),
]);

const TriggerBodySchema = t.Object({
	name: t.String({ minLength: 1 }),
	type: t.Union([
		t.Literal("webhook"),
		t.Literal("slack"),
		t.Literal("telegram-poll"),
		t.Literal("cron"),
	]),
	tenant: TenantMappingSchema,
	workload: t.String({ minLength: 1 }),
	config: t.Record(t.String(), t.Unknown()),
	driver: t.Optional(t.String({ minLength: 1 })),
	driverOptions: t.Optional(t.Record(t.String(), t.Unknown())),
});

export function triggerRoutes(deps: RouteDeps) {
	const { db } = deps;

	return new Elysia({ name: "triggers" })
		.get("/triggers", () => {
			return db.select().from(triggers).all();
		})
		.get("/triggers/:id", ({ params, set }) => {
			const row = db
				.select()
				.from(triggers)
				.where(eq(triggers.id, params.id as TriggerId))
				.get();
			if (!row) {
				set.status = 404;
				return { error: "Trigger not found" };
			}
			return row;
		})
		.post(
			"/triggers",
			({ body, set }) => {
				const existing = db
					.select()
					.from(triggers)
					.where(eq(triggers.name, body.name))
					.get();
				if (existing) {
					set.status = 409;
					return { error: `Trigger "${body.name}" already exists` };
				}

				const now = new Date();
				const row = {
					id: generateTriggerId(),
					name: body.name,
					type: body.type as "webhook" | "slack" | "telegram-poll" | "cron",
					tenant: body.tenant as { static: string } | { fromField: string; prefix?: string },
					workload: body.workload,
					config: body.config as Record<string, unknown>,
					driver: body.driver ?? null,
					driverOptions: body.driverOptions ?? null,
					enabled: 1,
					createdAt: now,
					updatedAt: now,
				};

				db.insert(triggers).values(row).run();
				set.status = 201;
				return row;
			},
			{ body: TriggerBodySchema },
		)
		.put(
			"/triggers/:id",
			({ params, body, set }) => {
				const existing = db
					.select()
					.from(triggers)
					.where(eq(triggers.id, params.id as TriggerId))
					.get();
				if (!existing) {
					set.status = 404;
					return { error: "Trigger not found" };
				}

				db.update(triggers)
					.set({
						name: body.name,
						type: body.type as "webhook" | "slack" | "telegram-poll" | "cron",
						tenant: body.tenant as { static: string } | { fromField: string; prefix?: string },
						workload: body.workload,
						config: body.config as Record<string, unknown>,
						driver: body.driver ?? null,
						driverOptions: body.driverOptions ?? null,
						updatedAt: new Date(),
					})
					.where(eq(triggers.id, params.id as TriggerId))
					.run();

				return db
					.select()
					.from(triggers)
					.where(eq(triggers.id, params.id as TriggerId))
					.get();
			},
			{ body: TriggerBodySchema },
		)
		.delete("/triggers/:id", ({ params, set }) => {
			const existing = db
				.select()
				.from(triggers)
				.where(eq(triggers.id, params.id as TriggerId))
				.get();
			if (!existing) {
				set.status = 404;
				return { error: "Trigger not found" };
			}

			db.delete(triggers).where(eq(triggers.id, params.id as TriggerId)).run();
			return { ok: true };
		})
		.post("/triggers/:id/enable", ({ params, set }) => {
			const existing = db
				.select()
				.from(triggers)
				.where(eq(triggers.id, params.id as TriggerId))
				.get();
			if (!existing) {
				set.status = 404;
				return { error: "Trigger not found" };
			}

			db.update(triggers)
				.set({ enabled: 1, updatedAt: new Date() })
				.where(eq(triggers.id, params.id as TriggerId))
				.run();

			return db
				.select()
				.from(triggers)
				.where(eq(triggers.id, params.id as TriggerId))
				.get();
		})
		.post("/triggers/:id/disable", ({ params, set }) => {
			const existing = db
				.select()
				.from(triggers)
				.where(eq(triggers.id, params.id as TriggerId))
				.get();
			if (!existing) {
				set.status = 404;
				return { error: "Trigger not found" };
			}

			db.update(triggers)
				.set({ enabled: 0, updatedAt: new Date() })
				.where(eq(triggers.id, params.id as TriggerId))
				.run();

			return db
				.select()
				.from(triggers)
				.where(eq(triggers.id, params.id as TriggerId))
				.get();
		})
		.post(
			"/triggers/:id/test",
			async ({ params, body, set }) => {
				const log = deps.log;
				const trigger = db
					.select()
					.from(triggers)
					.where(eq(triggers.id, params.id as TriggerId))
					.get();
				if (!trigger) {
					set.status = 404;
					return { error: "Trigger not found" };
				}

				const workloadRow = db
					.select()
					.from(workloads)
					.where(eq(workloads.name, trigger.workload))
					.get();
				if (!workloadRow) {
					set.status = 404;
					return { error: `Workload '${trigger.workload}' not found` };
				}
				if (workloadRow.status !== "ready") {
					set.status = 503;
					return { error: `Workload '${trigger.workload}' is not ready (status: ${workloadRow.status})` };
				}

				// Claim the tenant
				const tenantId = body.tenantId as TenantId;
				deps.activityLog.log({
					event: "trigger.invoked",
					tenantId,
					workloadId: workloadRow.workloadId,
					nodeId: deps.nodeId,
					metadata: { trigger: trigger.name, source: "test" },
				});
				log?.info({ triggerId: trigger.id, triggerName: trigger.name, tenantId, workload: trigger.workload }, "Trigger test: claiming tenant");
				let claim;
				try {
					claim = await deps.tenantManager.claim(tenantId, workloadRow.workloadId);
				} catch (err) {
					if (err instanceof InvalidTransitionError) {
						set.status = 409;
						return { error: err.message };
					}
					throw err;
				}

				deps.eventBus.emit({
					type: "tenant.claimed",
					tenantId,
					instanceId: claim.instanceId,
					workloadId: workloadRow.workloadId,
					source: claim.source,
				});

				// Forward payload to the container
				if (!claim.endpoint) {
					set.status = 502;
					return { error: "Container has no endpoint" };
				}
				const port = claim.endpoint.ports[0];
				if (!port) {
					set.status = 502;
					return { error: "Container has no exposed ports" };
				}
				const agentUrl = `http://${claim.endpoint.host}:${port}/`;
				log?.info({ agentUrl, source: claim.source, instanceId: claim.instanceId }, "Trigger test: claim complete");

				// Wait for container to accept connections before forwarding
				if (claim.source !== "existing") {
					log?.info({ agentUrl }, "Trigger test: waiting for container readiness");
					const readyDeadline = Date.now() + 15_000;
					let ready = false;
					let attempts = 0;
					while (Date.now() < readyDeadline) {
						attempts++;
						try {
							const probe = await fetch(agentUrl, {
								method: "GET",
								signal: AbortSignal.timeout(2_000),
							});
							const probeStatus = probe.status;
							await probe.text().catch(() => {});
							log?.info({ agentUrl, probeStatus, attempts }, "Trigger test: container ready");
							ready = true;
							break;
						} catch (err) {
							log?.debug({ agentUrl, attempts, err: err instanceof Error ? err.message : String(err) }, "Trigger test: readiness probe failed, retrying");
							await new Promise((r) => setTimeout(r, 500));
						}
					}
					if (!ready) {
						log?.warn({ agentUrl, attempts }, "Trigger test: container not ready after 15s");
						deps.activityLog.log({
							event: "trigger.error",
							tenantId,
							instanceId: claim.instanceId,
							workloadId: workloadRow.workloadId,
							nodeId: deps.nodeId,
							metadata: { trigger: trigger.name, source: "test", phase: "readiness", reason: "Container not ready after 15s" },
						});
						return {
							claim: {
								tenantId: claim.tenantId,
								instanceId: claim.instanceId,
								endpoint: { host: claim.endpoint.host, port },
								source: claim.source,
								latencyMs: claim.latencyMs,
							},
							response: null,
							error: `Container not ready after 15s at ${agentUrl}`,
						};
					}
				}

				log?.info({ agentUrl }, "Trigger test: forwarding payload");
				let agentResponse: unknown;
				let agentStatus: number;
				let res: Response;
				try {
					res = await fetch(agentUrl, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify(body.payload),
						signal: AbortSignal.timeout(30_000),
					});
				} catch (err) {
					const errMsg = err instanceof Error ? err.message : String(err);
					const isTimeout = err instanceof DOMException && err.name === "TimeoutError";
					log?.error({ agentUrl, err: errMsg, isTimeout }, "Trigger test: forward failed");
					const reason = isTimeout
						? "Container did not respond within 30s"
						: "Container endpoint unreachable";
					deps.activityLog.log({
						event: "trigger.error",
						tenantId,
						instanceId: claim.instanceId,
						workloadId: workloadRow.workloadId,
						nodeId: deps.nodeId,
						metadata: { trigger: trigger.name, source: "test", phase: "dispatch", reason },
					});
					return {
						claim: {
							tenantId: claim.tenantId,
							instanceId: claim.instanceId,
							endpoint: { host: claim.endpoint.host, port },
							source: claim.source,
							latencyMs: claim.latencyMs,
						},
						response: null,
						error: isTimeout
							? `Container did not respond within 30s at ${agentUrl}`
							: `Container endpoint unreachable at ${agentUrl}`,
					};
				}
				agentStatus = res.status;
				// Read body as text first, then try parsing as JSON
				const rawBody = await res.text();
				try {
					agentResponse = JSON.parse(rawBody);
				} catch {
					agentResponse = rawBody;
				}

				log?.info({ agentUrl, agentStatus }, "Trigger test: got response");

				deps.activityLog.log({
					event: "trigger.dispatched",
					tenantId,
					instanceId: claim.instanceId,
					workloadId: workloadRow.workloadId,
					nodeId: deps.nodeId,
					metadata: { trigger: trigger.name, source: "test", status: agentStatus },
				});

				// Update last invoked timestamp
				db.update(triggers)
					.set({ lastInvokedAt: new Date() })
					.where(eq(triggers.id, params.id as TriggerId))
					.run();

				return {
					claim: {
						tenantId: claim.tenantId,
						instanceId: claim.instanceId,
						endpoint: { host: claim.endpoint.host, port },
						source: claim.source,
						latencyMs: claim.latencyMs,
					},
					response: {
						status: agentStatus!,
						body: agentResponse,
					},
				};
			},
			{
				body: t.Object({
					tenantId: t.String({ minLength: 1 }),
					payload: t.Unknown(),
				}),
			},
		);
}
