/**
 * Resolves secret references to plaintext values.
 * - API server implements with SecretStore (AES-encrypted SQLite)
 * - Operator implements with K8s Secrets API
 */
export interface SecretRef {
  name: string;
  key: string;
}

export interface SecretResolver {
  resolve(ref: SecretRef): Promise<string>;
}
