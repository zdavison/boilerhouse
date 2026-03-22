import { statSync } from "node:fs";
import { eq, and } from "drizzle-orm";
import type {
	Runtime,
	RuntimeCapabilities,
	InstanceId,
	WorkloadId,
	NodeId,
	TenantId,
	SnapshotRef,
	Workload,
} from "@boilerhouse/core";
import { generateInstanceId } from "@boilerhouse/core";
import type { DrizzleDb } from "@boilerhouse/db";
import { snapshots, snapshotRefFrom } from "@boilerhouse/db";
import { applySnapshotTransition } from "./transitions";
import { pollHealth, createExecCheck, createHttpCheck } from "./health-check";
import type { HealthConfig, HealthCheckFn } from "./health-check";
import type { SecretStore } from "./secret-store";
import { generateEnvoyConfig } from "@boilerhouse/envoy-config";

export type HealthChecker = (check: HealthCheckFn, config: HealthConfig, onLog?: (line: string) => void) => Promise<void>;

export interface SnapshotManagerOptions {
	/**
	 * Override the health checker for testing.
	 * @default pollHealth
	 */
	healthChecker?: HealthChecker;
	/**
	 * Default health check timeout in ms, used when the workload
	 * doesn't specify enough info to derive one.
	 * @default 120000
	 */
	defaultHealthTimeoutMs?: number;
	/**
	 * Secret store for resolving credential references during golden boot.
	 */
	secretStore?: SecretStore;
}

export class SnapshotManager {
	private readonly healthChecker: HealthChecker;
	private readonly defaultHealthTimeoutMs: number;
	private readonly secretStore?: SecretStore;

	constructor(
		private readonly runtime: Runtime,
		private readonly db: DrizzleDb,
		private readonly nodeId: NodeId,
		options?: SnapshotManagerOptions,
	) {
		this.healthChecker = options?.healthChecker ?? pollHealth;
		this.defaultHealthTimeoutMs = options?.defaultHealthTimeoutMs ?? 120_000;
		this.secretStore = options?.secretStore;
	}

	get capabilities(): RuntimeCapabilities {
		return this.runtime.capabilities;
	}

	/**
	 * Creates a golden snapshot for a workload on this node.
	 *
	 * Cold boots an instance, waits for it to become healthy, takes a snapshot,
	 * then destroys the bootstrap instance. Uses upsert semantics — only one
	 * golden snapshot per workload+node combination is kept.
	 */
	async createGolden(
		workloadId: WorkloadId,
		workload: Workload,
		onLog?: (line: string) => void,
	): Promise<SnapshotRef> {
		const log = onLog ?? (() => {});
		const instanceId: InstanceId = generateInstanceId();

		// Build proxy config for golden boot if needed
		let createOptions: { proxyConfig?: string; onLog?: (line: string) => void } | undefined;
		if (workload.network.access === "restricted" && this.secretStore) {
			const allowlist = workload.network.allowlist ?? [];
			// During golden boot, only resolve global secrets (no tenant context)
			const credentials = workload.network.credentials?.map((cred) => {
				const resolvedHeaders: Record<string, string> = {};
				for (const [key, template] of Object.entries(cred.headers)) {
					// Skip tenant-secret refs during golden boot (no tenant)
					if (/\$\{tenant-secret:\w+\}/.test(template)) continue;
					resolvedHeaders[key] = this.secretStore!.resolveSecretRefs("" as TenantId, template);
				}
				return { domain: cred.domain, headers: resolvedHeaders };
			});
			const proxyConfig = generateEnvoyConfig({ allowlist, credentials });
			createOptions = { proxyConfig, onLog: log };
		} else {
			createOptions = { onLog: log };
		}

		log("Creating bootstrap instance...");
		const handle = await this.runtime.create(workload, instanceId, createOptions);

		log("Starting bootstrap instance...");
		await this.runtime.start(handle);

		// Helper to dump container logs into the bootstrap log stream
		const dumpContainerLogs = async (label: string) => {
			if (!this.runtime.logs) return;
			try {
				const logs = await this.runtime.logs(handle, 50);
				if (logs?.trim()) {
					log(`── container logs (${label}) ──`);
					for (const line of logs.trim().split("\n")) {
						log(`  ${line}`);
					}
					log(`── end container logs ──`);
				}
			} catch {
				// Ignore log fetch errors
			}
		};

		try {
			// Dump initial container output shortly after start
			if (this.runtime.logs) {
				await new Promise((r) => setTimeout(r, 1000));
				await dumpContainerLogs("after start");
			}

			// Poll health probe if the workload defines one.
			if (workload.health) {
				const intervalMs = workload.health.interval_seconds * 1000;

				let check: HealthCheckFn;

				if (workload.health.exec) {
					log(`Health check: exec [${workload.health.exec.command.join(" ")}]...`);
					check = createExecCheck(this.runtime, handle, workload.health.exec.command, log);
				} else if (workload.health.http_get) {
					const endpoint = await this.runtime.getEndpoint(handle);
					// endpoint.ports is ordered to match workload.network.expose.
					// Find the host port corresponding to the health check's guest port.
					const guestPort = workload.health.http_get.port;
					let portIndex = 0;
					if (guestPort != null && workload.network.expose) {
						const idx = workload.network.expose.findIndex((e) => e.guest === guestPort);
						if (idx >= 0) portIndex = idx;
					}
					const port = endpoint.ports[portIndex]!;
					const url = `http://${endpoint.host}:${port}${workload.health.http_get.path}`;
					log(`Health check: http [GET ${url}]...`);
					check = createHttpCheck(url, log);
				} else {
					throw new Error("Workload health config has no exec or http_get probe defined");
				}

				// Wrap check to dump container logs periodically on failures
				let failCount = 0;
				const wrappedCheck: HealthCheckFn = async () => {
					try {
						const ok = await check();
						if (ok) {
							failCount = 0;
							return true;
						}
						failCount++;
					} catch {
						failCount++;
					}
					// Dump logs every 5 failures so we can see what's happening
					if (failCount > 0 && failCount % 5 === 0) {
						await dumpContainerLogs(`health fail #${failCount}`);
					}
					return false;
				};

				const config: HealthConfig = {
					interval: intervalMs,
					unhealthyThreshold: workload.health.unhealthy_threshold,
					timeoutMs: Math.max(
						intervalMs * workload.health.unhealthy_threshold * 2,
						this.defaultHealthTimeoutMs,
					),
				};

				log(`Health check: timeout ${Math.round(config.timeoutMs / 1000)}s, interval ${Math.round(intervalMs / 1000)}s, threshold ${workload.health.unhealthy_threshold}`);
				try {
					await this.healthChecker(wrappedCheck, config, log);
				} catch (err) {
					// Dump final container logs before re-throwing health failure
					await dumpContainerLogs("health failed");
					throw err;
				}
				log("Health check passed.");
			}

			log("Taking snapshot...");
			// Take the snapshot
			const ref = await this.runtime.snapshot(handle);

			const goldenRef: SnapshotRef = {
				...ref,
				type: "golden",
				workloadId,
				nodeId: this.nodeId,
			};

			// Upsert — delete any existing golden for this workload+node, then insert
			this.db
				.delete(snapshots)
				.where(
					and(
						eq(snapshots.workloadId, workloadId),
						eq(snapshots.nodeId, this.nodeId),
						eq(snapshots.type, "golden"),
					),
				)
				.run();

			const sizeBytes = this.computeSnapshotSize(goldenRef);

			this.db
				.insert(snapshots)
				.values({
					snapshotId: goldenRef.id,
					type: "golden",
					status: "creating",
					instanceId,
					workloadId,
					nodeId: this.nodeId,
					vmstatePath: goldenRef.paths.vmstate,
					memoryPath: goldenRef.paths.memory,
					encrypted: goldenRef.encrypted ?? false,
					sizeBytes,
					runtimeMeta: goldenRef.runtimeMeta as Record<string, unknown>,
					createdAt: new Date(),
				})
				.run();

			applySnapshotTransition(this.db, goldenRef.id, "creating", "created");

			log("Destroying bootstrap instance...");
			// Destroy the bootstrap instance
			await this.runtime.destroy(handle);

			return goldenRef;
		} catch (err) {
			// Clean up the bootstrap instance on any failure
			try {
				await this.runtime.destroy(handle);
			} catch {
				// Ignore cleanup errors
			}
			throw err;
		}
	}

	/**
	 * Looks up the golden snapshot for a workload+node combination.
	 * Returns `null` if no golden snapshot exists or if runtime metadata
	 * is missing/incompatible.
	 */
	getGolden(workloadId: WorkloadId, nodeId: NodeId): SnapshotRef | null {
		const row = this.db
			.select()
			.from(snapshots)
			.where(
				and(
					eq(snapshots.workloadId, workloadId),
					eq(snapshots.nodeId, nodeId),
					eq(snapshots.type, "golden"),
					eq(snapshots.status, "ready"),
				),
			)
			.get();

		if (!row) return null;

		return snapshotRefFrom(row);
	}

	/** Fast boolean check for whether a golden snapshot exists. */
	goldenExists(workloadId: WorkloadId, nodeId: NodeId): boolean {
		return this.getGolden(workloadId, nodeId) !== null;
	}

	/** Computes total size of snapshot files. */
	private computeSnapshotSize(ref: SnapshotRef): number {
		let total = 0;
		try {
			total += statSync(ref.paths.vmstate).size;
		} catch {
			// File may not exist yet or be inaccessible
		}
		if (ref.paths.memory && ref.paths.memory !== ref.paths.vmstate) {
			try {
				total += statSync(ref.paths.memory).size;
			} catch {
				// File may not exist yet or be inaccessible
			}
		}
		return total;
	}
}
