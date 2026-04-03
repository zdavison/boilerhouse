import { describe, test, expect } from "bun:test";
import { createInternalApi } from "./internal-api";

describe("internal API", () => {
  test("returns 404 for unknown routes", async () => {
    const api = createInternalApi({});
    const resp = await api.fetch(new Request("http://localhost/unknown"));
    expect(resp.status).toBe(404);
  });

  test("GET /healthz returns 200", async () => {
    const api = createInternalApi({});
    const resp = await api.fetch(new Request("http://localhost/healthz"));
    expect(resp.status).toBe(200);
  });
});
