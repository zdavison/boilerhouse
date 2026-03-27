import { SpanStatusCode } from "@opentelemetry/api";
import type { Tracer } from "@opentelemetry/api";

/** Minimal interface matching InstanceManager methods we trace. */
interface TraceableInstanceManager {
	create(workloadId: string, workload: unknown, tenantId?: string): Promise<unknown>;
	destroy(instanceId: string): Promise<void>;
	hibernate(instanceId: string): Promise<unknown>;
}

/**
 * Wraps an InstanceManager with tracing spans.
 * Returns a proxy with the same interface — transparent to callers.
 */
export function wrapInstanceManager<T extends TraceableInstanceManager>(
	manager: T,
	tracer: Tracer,
): T {
	return new Proxy(manager, {
		get(target, prop, receiver) {
			if (prop === "create") {
				return async (workloadId: string, workload: unknown, tenantId?: string) => {
					return tracer.startActiveSpan("instance.create", async (span) => {
						span.setAttribute("workload.id", workloadId);
						if (tenantId) span.setAttribute("tenant.id", tenantId);
						try {
							const result = await target.create(workloadId, workload, tenantId);
							const handle = result as { instanceId?: string };
							if (handle.instanceId) span.setAttribute("instance.id", handle.instanceId);
							return result;
						} catch (err) {
							span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
							span.recordException(err as Error);
							throw err;
						} finally {
							span.end();
						}
					});
				};
			}

			if (prop === "destroy") {
				return async (instanceId: string) => {
					return tracer.startActiveSpan("instance.destroy", async (span) => {
						span.setAttribute("instance.id", instanceId);
						try {
							await target.destroy(instanceId);
						} catch (err) {
							span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
							span.recordException(err as Error);
							throw err;
						} finally {
							span.end();
						}
					});
				};
			}

			if (prop === "hibernate") {
				return async (instanceId: string) => {
					return tracer.startActiveSpan("instance.hibernate", async (span) => {
						span.setAttribute("instance.id", instanceId);
						try {
							const result = await target.hibernate(instanceId);
							const ref = result as { id?: string };
							if (ref.id) span.setAttribute("snapshot.id", ref.id);
							return result;
						} catch (err) {
							span.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
							span.recordException(err as Error);
							throw err;
						} finally {
							span.end();
						}
					});
				};
			}

			return Reflect.get(target, prop, receiver);
		},
	});
}
