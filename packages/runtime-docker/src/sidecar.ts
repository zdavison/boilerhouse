import { mkdtempSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DockerClient } from "./client";
import { DockerRuntimeError } from "./errors";

/** Envoy sidecar image for per-instance network proxy containers. */
const ENVOY_IMAGE = "docker.io/envoyproxy/envoy:v1.32-latest";
/** Minimal image with iptables for the transparent redirect init container. */
const IPTABLES_IMAGE = "docker.io/alpine:3.21";
const ENVOY_HTTP_PORT = 18080;
const ENVOY_TLS_PORT = 18443;

export { ENVOY_IMAGE };

/** Tracks temp files created for a sidecar so they can be cleaned up on destroy. */
export interface SidecarState {
	configPath: string;
	certsDir?: string;
	caCertPath?: string;
}

export interface SidecarCreateOptions {
	proxyConfig: string;
	proxyCaCert?: string;
	proxyCerts?: Array<{ domain: string; cert: string; key: string }>;
}

/**
 * Manages the Envoy sidecar proxy and iptables init container lifecycle.
 * Each instance that needs network policy enforcement gets a sidecar.
 */
export class DockerSidecar {
	private readonly tmpBase: string;

	constructor(private readonly client: DockerClient, tmpBase?: string) {
		this.tmpBase = tmpBase ?? tmpdir();
	}

	/**
	 * Prepares CA cert for mount into the workload container and returns
	 * additional bind mounts and env vars the workload container needs.
	 */
	prepareCaCert(
		instanceId: string,
		proxyCaCert: string,
	): { caCertPath: string; binds: string[]; env: Record<string, string> } {
		const caCertPath = join(this.tmpBase, `boilerhouse-${instanceId}-ca.crt`);
		writeFileSync(caCertPath, proxyCaCert);
		return {
			caCertPath,
			binds: [`${caCertPath}:/etc/boilerhouse/proxy-ca.crt:ro`],
			env: { NODE_EXTRA_CA_CERTS: "/etc/boilerhouse/proxy-ca.crt" },
		};
	}

	/** Pull an image if it doesn't exist locally. */
	private async ensureImage(image: string): Promise<void> {
		const exists = await this.client.imageExists(image);
		if (!exists) {
			await this.client.pullImage(image);
		}
	}

	/**
	 * Creates the Envoy sidecar and iptables init container for an instance.
	 * Both share the workload container's network namespace.
	 */
	async create(
		instanceId: string,
		options: SidecarCreateOptions,
	): Promise<SidecarState> {
		const configPath = join(this.tmpBase, `boilerhouse-${instanceId}-envoy.yaml`);
		writeFileSync(configPath, options.proxyConfig);

		// Write per-domain TLS certs for MITM
		const envoyBinds: string[] = [`${configPath}:/etc/envoy/envoy.yaml:ro`];
		let certsDir: string | undefined;
		if (options.proxyCerts && options.proxyCerts.length > 0) {
			certsDir = mkdtempSync(join(this.tmpBase, `boilerhouse-${instanceId}-certs-`));
			for (const { domain, cert, key } of options.proxyCerts) {
				const safe = domain.replace(/[.*]/g, "_").replace(/^_+/, "");
				writeFileSync(join(certsDir, `${safe}.crt`), cert);
				writeFileSync(join(certsDir, `${safe}.key`), key);
			}
			envoyBinds.push(`${certsDir}:/etc/envoy/certs:ro`);
		}

		// Ensure sidecar images are available
		await this.ensureImage(ENVOY_IMAGE);
		await this.ensureImage(IPTABLES_IMAGE);

		// Envoy sidecar — shares workload's network namespace
		await this.client.createContainer(`${instanceId}-proxy`, {
			Image: ENVOY_IMAGE,
			Entrypoint: ["envoy"],
			Cmd: ["-c", "/etc/envoy/envoy.yaml", "--log-level", "info"],
			User: "envoy",
			Labels: {
				"boilerhouse.managed": "true",
				"boilerhouse.role": "proxy",
			},
			HostConfig: {
				CapDrop: ["ALL"],
				SecurityOpt: ["no-new-privileges:true"],
				ReadonlyRootfs: true,
				NetworkMode: `container:${instanceId}`,
				Binds: envoyBinds,
			},
		});

		// iptables init container — blocks metadata server, sets up transparent redirect, then exits.
		await this.client.createContainer(`${instanceId}-iptables-init`, {
			Image: IPTABLES_IMAGE,
			Cmd: ["sh", "-c", [
				"apk add --no-cache -q iptables",
				"iptables -A OUTPUT -d 169.254.0.0/16 -j DROP",
				"iptables -t nat -A OUTPUT -m owner --uid-owner 101 -j RETURN",
				`iptables -t nat -A OUTPUT -p tcp --dport 80 -j REDIRECT --to-port ${ENVOY_HTTP_PORT}`,
				`iptables -t nat -A OUTPUT -p tcp --dport 443 -j REDIRECT --to-port ${ENVOY_TLS_PORT}`,
			].join(" && ")],
			Labels: {
				"boilerhouse.managed": "true",
				"boilerhouse.role": "init",
			},
			HostConfig: {
				CapDrop: ["ALL"],
				CapAdd: ["NET_ADMIN"],
				SecurityOpt: ["no-new-privileges:true"],
				NetworkMode: `container:${instanceId}`,
			},
		});

		return { configPath, certsDir };
	}

	/**
	 * Starts the sidecar and runs the iptables init container.
	 * The init container is removed after it exits successfully.
	 */
	async start(instanceId: string): Promise<void> {
		await this.client.startContainer(`${instanceId}-proxy`);

		await this.client.startContainer(`${instanceId}-iptables-init`);
		const { StatusCode } = await this.client.waitContainer(`${instanceId}-iptables-init`);
		if (StatusCode !== 0) {
			const logs = await this.client.containerLogs(`${instanceId}-iptables-init`, 20);
			throw new DockerRuntimeError(
				`iptables init failed (exit ${StatusCode}): ${logs}`,
			);
		}
		await this.client.removeContainer(`${instanceId}-iptables-init`);
	}

	/**
	 * Runs a minimal iptables init container in the workload's network namespace
	 * to block the cloud metadata server (169.254.0.0/16).
	 * Used for outbound containers that have no Envoy sidecar.
	 */
	async blockMetadataServer(instanceId: string): Promise<void> {
		const name = `${instanceId}-metadata-block`;
		await this.client.createContainer(name, {
			Image: IPTABLES_IMAGE,
			Cmd: ["sh", "-c", [
				"apk add --no-cache -q iptables",
				"iptables -A OUTPUT -d 169.254.0.0/16 -j DROP",
			].join(" && ")],
			Labels: {
				"boilerhouse.managed": "true",
				"boilerhouse.role": "init",
			},
			HostConfig: {
				CapDrop: ["ALL"],
				CapAdd: ["NET_ADMIN"],
				SecurityOpt: ["no-new-privileges:true"],
				NetworkMode: `container:${instanceId}`,
			},
		});
		await this.client.startContainer(name);
		const { StatusCode } = await this.client.waitContainer(name);
		await this.client.removeContainer(name);
		if (StatusCode !== 0) {
			throw new DockerRuntimeError(
				`Metadata server block init failed (exit ${StatusCode}) for ${instanceId}`,
			);
		}
	}

	/**
	 * Destroys the sidecar containers and cleans up temp files.
	 */
	async destroy(instanceId: string, state: SidecarState): Promise<void> {
		await this.client.removeContainer(`${instanceId}-proxy`);

		// Best-effort cleanup of temp files
		for (const p of [state.configPath, state.caCertPath]) {
			if (p) try { unlinkSync(p); } catch { /* */ }
		}
		if (state.certsDir) {
			try { rmSync(state.certsDir, { recursive: true, force: true }); } catch { /* */ }
		}
	}
}
