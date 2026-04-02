import { describe, test, expect } from "bun:test";
import { KubeSecretResolver } from "./secret-resolver";

describe("KubeSecretResolver", () => {
  test("implements SecretResolver interface", () => {
    const resolver = new KubeSecretResolver({
      apiUrl: "http://localhost:8001",
      headers: {},
      namespace: "default",
    });
    expect(typeof resolver.resolve).toBe("function");
  });
});
