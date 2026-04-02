import type { InstanceManager } from "@boilerhouse/domain";
import type { DrizzleDb } from "@boilerhouse/db";

export interface InternalApiDeps {
  instanceManager?: InstanceManager;
  db?: DrizzleDb;
}

export function createInternalApi(deps: InternalApiDeps) {
  return {
    fetch: async (req: Request): Promise<Response> => {
      const url = new URL(req.url);
      const path = url.pathname;

      if (path === "/healthz") {
        return new Response("ok", { status: 200 });
      }

      if (req.method === "GET" && path.match(/^\/api\/v1\/instances\/[^/]+\/stats$/)) {
        const instanceId = path.split("/")[4];
        // Stats endpoint — returns null until wired to runtime in bootstrap
        return Response.json({ instanceId, stats: null });
      }

      if (req.method === "POST" && path.match(/^\/api\/v1\/instances\/[^/]+\/overlay\/extract$/)) {
        const instanceId = path.split("/")[4];
        return Response.json({ instanceId, extracted: false });
      }

      if (req.method === "POST" && path.match(/^\/api\/v1\/instances\/[^/]+\/snapshot$/)) {
        const instanceId = path.split("/")[4];
        return Response.json({ instanceId, snapshot: null });
      }

      return new Response("not found", { status: 404 });
    },
  };
}
