import type { InstanceId } from "./types";
import { generateSnapshotId, generateWorkloadId, generateNodeId } from "./types";
import type { SnapshotRef } from "./snapshot";
import type { Workload } from "./workload";
import type { Runtime, RuntimeCapabilities, InstanceHandle, Endpoint, ExecResult, CreateOptions } from "./runtime";

type RuntimeOperation =
	| "create"
	| "start"
	| "destroy"
	| "snapshot"
	| "restore"
	| "exec"
	| "getEndpoint"
	| "list";

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
	/**
	 * Result returned by `exec()`.
	 * @default { exitCode: 0, stdout: "", stderr: "" }
	 */
	execResult?: ExecResult;
	/**
	 * Whether golden snapshots are supported.
	 * @default true
	 */
	goldenSnapshots?: boolean;
}

interface FakeInstance {
	instanceId: InstanceId;
	workload: Workload;
	running: boolean;
	destroyed: boolean;
	ports: number[];
}

export class FakeRuntime implements Runtime {
	readonly capabilities: RuntimeCapabilities;
	private instances = new Map<string, FakeInstance>();
	private snapshots = new Map<string, SnapshotRef>();
	private nextPort = 30000;
	private readonly latencyMs: number;
	private readonly failOn: Set<RuntimeOperation>;
	private readonly execResult: ExecResult;

	constructor(options?: FakeRuntimeOptions) {
		this.latencyMs = options?.latencyMs ?? 0;
		this.failOn = options?.failOn ?? new Set();
		this.execResult = options?.execResult ?? { exitCode: 0, stdout: "", stderr: "" };
		this.capabilities = { goldenSnapshots: options?.goldenSnapshots ?? true };
	}

	async create(
		workload: Workload,
		instanceId: InstanceId,
		_options?: CreateOptions,
	): Promise<InstanceHandle> {
		await this.maybeDelay("create");
		const ports = (workload.network.expose ?? []).map((e) => e.guest);
		if (ports.length === 0) ports.push(this.nextPort++);
		const instance: FakeInstance = {
			instanceId,
			workload,
			running: false,
			destroyed: false,
			ports,
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

	async destroy(handle: InstanceHandle): Promise<void> {
		await this.maybeDelay("destroy");
		const instance = this.instances.get(handle.instanceId);
		if (instance) {
			instance.destroyed = true;
			instance.running = false;
			this.instances.delete(handle.instanceId);
		}
		handle.running = false;
	}

	async snapshot(handle: InstanceHandle): Promise<SnapshotRef> {
		await this.maybeDelay("snapshot");
		this.requireInstance(handle.instanceId);
		const id = generateSnapshotId();
		const ref: SnapshotRef = {
			id,
			type: "tenant",
			paths: {
				memory: `/fake-snapshots/${id}/snapshot`,
				vmstate: `/fake-snapshots/${id}/snapshot`,
			},
			workloadId: generateWorkloadId(),
			nodeId: generateNodeId(),
			runtimeMeta: {
				runtimeVersion: "fake-1.0.0",
				architecture: "x86_64",
			},
		};
		this.snapshots.set(id, ref);
		return ref;
	}

	async restore(
		ref: SnapshotRef,
		instanceId: InstanceId,
		_options?: CreateOptions,
	): Promise<InstanceHandle> {
		await this.maybeDelay("restore");
		if (!this.snapshots.has(ref.id)) {
			throw new Error(`Snapshot not found: ${ref.id}`);
		}
		const ports = ref.runtimeMeta.exposedPorts ?? [this.nextPort++];
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
			ports,
		};
		this.instances.set(instanceId, instance);
		return { instanceId, running: true };
	}

	async exec(handle: InstanceHandle, _command: string[]): Promise<ExecResult> {
		await this.maybeDelay("exec");
		this.requireInstance(handle.instanceId);
		return { ...this.execResult };
	}

	async getEndpoint(handle: InstanceHandle): Promise<Endpoint> {
		await this.maybeDelay("getEndpoint");
		const instance = this.requireInstance(handle.instanceId);
		return { host: "127.0.0.1", ports: instance.ports };
	}

	async list(): Promise<InstanceId[]> {
		await this.maybeDelay("list");
		return Array.from(this.instances.keys()) as InstanceId[];
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
