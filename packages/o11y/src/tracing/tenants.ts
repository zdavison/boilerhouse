import { SpanStatusCode } from "@opentelemetry/api";
import type { Tracer } from "@opentelemetry/api";

/** Minimal interface matching TenantManager.claim() */
interface ClaimableTenantManager {
	claim(tenantId: string, workloadId: string): Promise<{
		tenantId: string;
		instanceId: string;
		endpoint: unknown;
		source: string;
		latencyMs: number;
	}>;
	release(tenantId: string, workloadId: string): Promise<void>;
}

/**
 * Wraps a TenantManager with tracing spans on claim and release.
 * Returns a proxy with the same interface — transparent to callers.
 */
export function wrapTenantManager<T extends ClaimableTenantManager>(
	manager: T,
	tracer: Tracer,
): T {
	return new Proxy(manager, {
		get(target, prop, receiver) {
			if (prop === "claim") {
				return async (tenantId: string, workloadId: string) => {
					return tracer.startActiveSpan("tenant.claim", async (span) => {
						span.setAttributes({
							"tenant.id": tenantId,
							"workload.id": workloadId,
						});
						try {
							const result = await target.claim(tenantId, workloadId);
							span.setAttributes({
								"claim.source": result.source,
								"instance.id": result.instanceId,
							});
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

			if (prop === "release") {
				return async (tenantId: string, workloadId: string) => {
					return tracer.startActiveSpan("tenant.release", async (span) => {
						span.setAttributes({ "tenant.id": tenantId, "workload.id": workloadId });
						try {
							await target.release(tenantId, workloadId);
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
