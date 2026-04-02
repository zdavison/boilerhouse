import type { SecretResolver, SecretRef } from "@boilerhouse/domain";

export interface KubeSecretResolverConfig {
  apiUrl: string;
  headers: Record<string, string>;
  namespace: string;
}

/**
 * Resolves SecretRef by reading native K8s Secrets.
 */
export class KubeSecretResolver implements SecretResolver {
  constructor(private readonly config: KubeSecretResolverConfig) {}

  async resolve(ref: SecretRef): Promise<string> {
    const url = `${this.config.apiUrl}/api/v1/namespaces/${this.config.namespace}/secrets/${ref.name}`;
    const resp = await fetch(url, { headers: this.config.headers });

    if (!resp.ok) {
      throw new Error(`Failed to read secret "${ref.name}": ${resp.status}`);
    }

    const secret = (await resp.json()) as { data?: Record<string, string> };
    const encoded = secret.data?.[ref.key];
    if (!encoded) {
      throw new Error(`Key "${ref.key}" not found in secret "${ref.name}"`);
    }

    // K8s secrets are base64-encoded
    return Buffer.from(encoded, "base64").toString("utf-8");
  }
}
