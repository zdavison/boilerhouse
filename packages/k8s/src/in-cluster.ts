import { existsSync, readFileSync } from "node:fs";
import { KubernetesRuntimeError } from "./errors";

const SA_TOKEN_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/token";
const SA_CA_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt";
const SA_NAMESPACE_PATH = "/var/run/secrets/kubernetes.io/serviceaccount/namespace";
const IN_CLUSTER_API_URL = "https://kubernetes.default.svc";

export interface InClusterConfig {
	apiUrl: string;
	token: string;
	caCert: string;
	namespace: string;
}

/**
 * Returns true if running inside a Kubernetes pod with a mounted
 * service account token.
 */
export function isInCluster(): boolean {
	return existsSync(SA_TOKEN_PATH);
}

/**
 * Reads connection details from the service account token and CA cert
 * automatically mounted into every K8s pod.
 *
 * @throws {KubernetesRuntimeError} If the service account files are missing.
 */
export function resolveInClusterConfig(): InClusterConfig {
	if (!existsSync(SA_TOKEN_PATH)) {
		throw new KubernetesRuntimeError(
			`Not running in-cluster: ${SA_TOKEN_PATH} not found. ` +
			`Provide apiUrl and token explicitly.`,
		);
	}

	const token = readFileSync(SA_TOKEN_PATH, "utf-8").trim();
	const caCert = existsSync(SA_CA_PATH)
		? readFileSync(SA_CA_PATH, "utf-8")
		: "";
	const namespace = existsSync(SA_NAMESPACE_PATH)
		? readFileSync(SA_NAMESPACE_PATH, "utf-8").trim()
		: "boilerhouse";

	return {
		apiUrl: IN_CLUSTER_API_URL,
		token,
		caCert,
		namespace,
	};
}
