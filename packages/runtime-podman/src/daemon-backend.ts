import * as http from "node:http";
import type { ContainerBackend, CheckpointResult, BackendInfo, EnsureImageResult } from "./backend";
import type { ContainerCreateSpec, ContainerInspect, ExecResult } from "./client";
import { PodmanRuntimeError } from "./errors";

export interface DaemonBackendConfig {
	/** Path to the boilerhouse-podmand Unix socket. */
	socketPath: string;
}

/**
 * HTTP-over-Unix-socket client that talks to `boilerhouse-podmand`.
 * Same communication pattern as `PodmanClient` but speaks the daemon's API.
 */
export class DaemonBackend implements ContainerBackend {
	private readonly socketPath: string;

	constructor(config: DaemonBackendConfig) {
		this.socketPath = config.socketPath;
	}

	async info(): Promise<BackendInfo> {
		const res = await this.request("GET", "/info");
		return res as BackendInfo;
	}

	async ensureImage(
		image: { ref?: string; dockerfile?: string },
		workload: { name: string; version: string },
	): Promise<EnsureImageResult> {
		const body: Record<string, string> = {};
		if (image.ref) body.ref = image.ref;
		if (image.dockerfile) {
			body.dockerfile = image.dockerfile;
			body.tag = `boilerhouse/${workload.name}:${workload.version}`;
		}

		const res = await this.request("POST", "/images/ensure", body);
		const { image: resolvedImage, action } = res as { image: string; action: string };
		return {
			image: resolvedImage,
			action: (action as EnsureImageResult["action"]) ?? "cached",
		};
	}

	async createContainer(spec: ContainerCreateSpec): Promise<string> {
		const res = await this.request("POST", "/containers", { spec });
		return (res as { id: string }).id;
	}

	async startContainer(id: string): Promise<void> {
		await this.request("POST", `/containers/${encodeURIComponent(id)}/start`);
	}

	async inspectContainer(id: string): Promise<ContainerInspect> {
		const res = await this.request("GET", `/containers/${encodeURIComponent(id)}`);
		return res as ContainerInspect;
	}

	async removeContainer(id: string): Promise<void> {
		await this.request("DELETE", `/containers/${encodeURIComponent(id)}`);
	}

	async checkpoint(id: string, archiveDir: string): Promise<CheckpointResult> {
		const res = await this.request(
			"POST",
			`/containers/${encodeURIComponent(id)}/checkpoint`,
			{ archiveDir },
		);
		return res as CheckpointResult;
	}

	async restore(
		archivePath: string,
		name: string,
		publishPorts?: string[],
		pod?: string,
		encrypted?: boolean,
	): Promise<string> {
		const res = await this.request("POST", "/containers/restore", {
			archivePath,
			name,
			publishPorts,
			pod,
			encrypted,
		});
		return (res as { id: string }).id;
	}

	async exec(id: string, cmd: string[]): Promise<ExecResult> {
		const res = await this.request(
			"POST",
			`/containers/${encodeURIComponent(id)}/exec`,
			{ cmd },
		);
		return res as ExecResult;
	}

	async listContainers(): Promise<string[]> {
		const res = await this.request("GET", "/containers");
		return (res as { ids: string[] }).ids;
	}

	async logs(id: string, tail = 100): Promise<string> {
		const res = await this.request(
			"GET",
			`/containers/${encodeURIComponent(id)}/logs?tail=${tail}`,
		);
		return (res as { logs: string }).logs;
	}

	// ── Pod operations ──────────────────────────────────────────────────────

	async inspectPod(name: string): Promise<{ infraContainerId: string }> {
		const res = await this.request("GET", `/pods/${encodeURIComponent(name)}`);
		return res as { infraContainerId: string };
	}

	async createPod(name: string, spec?: { portmappings?: Array<{ container_port: number; host_port: number; protocol?: string }>; netns?: { nsmode: string } }): Promise<void> {
		await this.request("POST", "/pods", { name, ...spec });
	}

	async startPod(name: string): Promise<void> {
		await this.request("POST", `/pods/${encodeURIComponent(name)}/start`);
	}

	async removePod(name: string): Promise<void> {
		await this.request("DELETE", `/pods/${encodeURIComponent(name)}`);
	}

	// ── File operations ─────────────────────────────────────────────────────

	async writeFile(name: string, content: string): Promise<string> {
		const res = await this.request("POST", "/files", { name, content });
		return (res as { path: string }).path;
	}

	async removeFile(name: string): Promise<void> {
		await this.request("DELETE", `/files/${encodeURIComponent(name)}`);
	}

	// ── HTTP transport ──────────────────────────────────────────────────────

	private request(
		method: string,
		path: string,
		body?: object,
	): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const bodyData = body ? Buffer.from(JSON.stringify(body)) : undefined;
			const headers: Record<string, string> = {};
			if (bodyData) {
				headers["Content-Type"] = "application/json";
				headers["Content-Length"] = String(bodyData.length);
			}

			const req = http.request(
				{
					socketPath: this.socketPath,
					path,
					method,
					headers,
				},
				(res) => {
					const chunks: Buffer[] = [];
					res.on("data", (chunk: Buffer) => chunks.push(chunk));
					res.on("end", () => {
						const raw = Buffer.concat(chunks).toString("utf-8");
						let parsed: unknown;
						try {
							parsed = raw ? JSON.parse(raw) : null;
						} catch {
							parsed = raw;
						}

						const status = res.statusCode ?? 0;
						if (status >= 400) {
							const msg =
								(parsed as Record<string, unknown>)?.error ??
								`HTTP ${status}`;
							reject(
								new PodmanRuntimeError(
									`Daemon request ${method} ${path} failed: ${msg}`,
								),
							);
							return;
						}

						resolve(parsed);
					});
					res.on("error", reject);
				},
			);

			req.on("error", (err) => {
				reject(
					new PodmanRuntimeError(
						`Daemon request failed: ${err.message}`,
					),
				);
			});

			if (bodyData) {
				req.write(bodyData);
			}
			req.end();
		});
	}
}
