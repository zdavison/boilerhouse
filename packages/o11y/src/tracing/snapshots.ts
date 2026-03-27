import { SpanStatusCode } from "@opentelemetry/api";
import type { Tracer } from "@opentelemetry/api";

/** Minimal interface matching SnapshotManager.createGolden(). */
interface TraceableSnapshotManager {
	createGolden(workloadId: string, workload: unknown, onLog?: (line: string) => void): Promise<unknown>;
}

/**
 * Wraps a SnapshotManager with tracing spans on createGolden.
 * Returns a proxy with the same interface — transparent to callers.
 */
export function wrapSnapshotManager<T extends TraceableSnapshotManager>(
	manager: T,
	tracer: Tracer,
): T {
	return new Proxy(manager, {
		get(target, prop, receiver) {
			if (prop === "createGolden") {
				return async (workloadId: string, workload: unknown, onLog?: (line: string) => void) => {
					return tracer.startActiveSpan("snapshot.create_golden", async (span) => {
						span.setAttribute("workload.id", workloadId);
						try {
							const result = await target.createGolden(workloadId, workload, onLog);
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
