import type { InstanceId } from "./types";
import { generateSnapshotId, generateWorkloadId, generateNodeId } from "./types";
import type { SnapshotRef } from "./snapshot";
import type { Workload } from "./workload";
import type { Runtime, InstanceHandle, Endpoint } from "./runtime";

type RuntimeOperation =
	| "create"
	| "start"
	| "stop"
	| "destroy"
	| "snapshot"
	| "restore"
	| "getEndpoint";

export interface FakeRuntimeOptions {
	/**
	 * Artificial latency (ms) added to every operation.
	 * @default 0
	 */
	latencyMs?: number;
	/**
	 * Set of operations that should throw an injected failure.
	 * @example new Set(["start", "snapshot"])
	 */
	failOn?: Set<RuntimeOperation>;
}

interface FakeInstance {
	instanceId: InstanceId;
	workload: Workload;
	running: boolean;
	destroyed: boolean;
	port: number;
}

export class FakeRuntime implements Runtime {
	private instances = new Map<string, FakeInstance>();
	private snapshots = new Map<string, SnapshotRef>();
	private nextPort = 30000;
	private readonly latencyMs: number;
	private readonly failOn: Set<RuntimeOperation>;

	constructor(options?: FakeRuntimeOptions) {
		this.latencyMs = options?.latencyMs ?? 0;
		this.failOn = options?.failOn ?? new Set();
	}

	async create(
		workload: Workload,
		instanceId: InstanceId,
	): Promise<InstanceHandle> {
		await this.maybeDelay("create");
		const port = this.nextPort++;
		const instance: FakeInstance = {
			instanceId,
			workload,
			running: false,
			destroyed: false,
			port,
		};
		this.instances.set(instanceId, instance);
		return { instanceId, running: false };
	}

	async start(handle: InstanceHandle): Promise<void> {
		await this.maybeDelay("start");
		const instance = this.requireInstance(handle.instanceId);
		instance.running = true;
		handle.running = true;
	}

	async stop(handle: InstanceHandle): Promise<void> {
		await this.maybeDelay("stop");
		const instance = this.requireInstance(handle.instanceId);
		instance.running = false;
		handle.running = false;
	}

	async destroy(handle: InstanceHandle): Promise<void> {
		await this.maybeDelay("destroy");
		const instance = this.requireInstance(handle.instanceId);
		instance.destroyed = true;
		instance.running = false;
		handle.running = false;
		this.instances.delete(handle.instanceId);
	}

	async snapshot(handle: InstanceHandle): Promise<SnapshotRef> {
		await this.maybeDelay("snapshot");
		this.requireInstance(handle.instanceId);
		const id = generateSnapshotId();
		const ref: SnapshotRef = {
			id,
			type: "tenant",
			paths: {
				memory: `/fake-snapshots/${id}/memory`,
				vmstate: `/fake-snapshots/${id}/vmstate`,
			},
			workloadId: generateWorkloadId(),
			nodeId: generateNodeId(),
			runtimeMeta: {
				runtimeVersion: "fake-1.0.0",
				cpuTemplate: "none",
				architecture: "x86_64",
			},
		};
		this.snapshots.set(id, ref);
		return ref;
	}

	async restore(
		ref: SnapshotRef,
		instanceId: InstanceId,
	): Promise<InstanceHandle> {
		await this.maybeDelay("restore");
		if (!this.snapshots.has(ref.id)) {
			throw new Error(`Snapshot not found: ${ref.id}`);
		}
		const port = this.nextPort++;
		const instance: FakeInstance = {
			instanceId,
			workload: {
				workload: { name: "restored", version: "0.0.0" },
				image: { ref: "restored:latest" },
				resources: { vcpus: 1, memory_mb: 256, disk_gb: 2 },
				network: { access: "none" },
				idle: { action: "hibernate" },
			},
			running: true,
			destroyed: false,
			port,
		};
		this.instances.set(instanceId, instance);
		return { instanceId, running: true };
	}

	async getEndpoint(handle: InstanceHandle): Promise<Endpoint> {
		await this.maybeDelay("getEndpoint");
		const instance = this.requireInstance(handle.instanceId);
		return { host: "127.0.0.1", port: instance.port };
	}

	async available(): Promise<boolean> {
		return true;
	}

	private requireInstance(instanceId: InstanceId): FakeInstance {
		const instance = this.instances.get(instanceId);
		if (!instance) {
			throw new Error(`Instance destroyed or not found: ${instanceId}`);
		}
		return instance;
	}

	private async maybeDelay(operation: RuntimeOperation): Promise<void> {
		if (this.failOn.has(operation)) {
			throw new Error(`Injected failure on '${operation}'`);
		}
		if (this.latencyMs > 0) {
			await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
		}
	}
}
