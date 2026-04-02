import type { InstanceId } from "./types";
import type { Workload } from "./workload";
import type { Runtime, InstanceHandle, Endpoint, ExecResult, ExecOptions, CreateOptions } from "./runtime";

type RuntimeOperation =
	| "create"
	| "start"
	| "destroy"
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
	 * @example new Set(["start"])
	 */
	failOn?: Set<RuntimeOperation>;
	/**
	 * Result returned by `exec()`.
	 * @default { exitCode: 0, stdout: "", stderr: "" }
	 */
	execResult?: ExecResult;
}

interface FakeInstance {
	instanceId: InstanceId;
	workload: Workload;
	running: boolean;
	paused: boolean;
	destroyed: boolean;
	ports: number[];
	/** Simulated overlay data stored by extractOverlayArchive. */
	overlayData?: Buffer;
	/** HTTP servers started for health-checkable instances. */
	httpServers?: Array<{ server: ReturnType<typeof Bun.serve>; port: number }>;
}

export class FakeRuntime implements Runtime {
	private instances = new Map<string, FakeInstance>();
	private nextPort = 30000;
	private readonly latencyMs: number;
	private readonly failOn: Set<RuntimeOperation>;
	private execResult: ExecResult;
	/** The options passed to the most recent exec() call. */
	lastExecOptions?: ExecOptions;

	constructor(options?: FakeRuntimeOptions) {
		this.latencyMs = options?.latencyMs ?? 0;
		this.failOn = options?.failOn ?? new Set();
		this.execResult = options?.execResult ?? { exitCode: 0, stdout: "", stderr: "" };
	}

	async create(
		workload: Workload,
		instanceId: InstanceId,
		_options?: CreateOptions,
	): Promise<InstanceHandle> {
		await this.maybeDelay("create");
		const exposedPorts = workload.network.expose ?? [];
		const httpServers: FakeInstance["httpServers"] = [];
		const ports: number[] = [];

		for (const _exp of exposedPorts) {
			// Start a real HTTP server on port 0 (OS-assigned) so health checks work
			const server = Bun.serve({
				port: 0,
				fetch: () => new Response("ok"),
			});
			httpServers.push({ server, port: server.port });
			ports.push(server.port);
		}

		if (ports.length === 0) ports.push(this.nextPort++);

		const instance: FakeInstance = {
			instanceId,
			workload,
			running: false,
			paused: false,
			destroyed: false,
			ports,
			httpServers: httpServers.length > 0 ? httpServers : undefined,
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
			if (instance.httpServers) {
				for (const { server } of instance.httpServers) {
					server.stop(true);
				}
			}
			instance.destroyed = true;
			instance.running = false;
			this.instances.delete(handle.instanceId);
		}
		handle.running = false;
	}

	/** Override the result returned by exec() after construction. Useful in tests. */
	setExecResult(result: ExecResult): void {
		this.execResult = result;
	}

	async exec(handle: InstanceHandle, _command: string[], options?: ExecOptions): Promise<ExecResult> {
		await this.maybeDelay("exec");
		this.requireInstance(handle.instanceId);
		this.lastExecOptions = options;
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

	async pause(handle: InstanceHandle): Promise<void> {
		const instance = this.requireInstance(handle.instanceId);
		instance.paused = true;
	}

	async unpause(handle: InstanceHandle): Promise<void> {
		const instance = this.requireInstance(handle.instanceId);
		instance.paused = false;
	}

	async extractOverlayArchive(instanceId: InstanceId, _overlayDirs: string[]): Promise<Buffer | null> {
		const instance = this.instances.get(instanceId);
		if (!instance) return null;
		// Return a small valid gzip buffer to simulate overlay data
		return instance.overlayData ?? Buffer.from("H4sIAAAAAAAAA2NgGAUAAAADAP8AHcnoYwAAAA==", "base64");
	}

	async statOverlayDirs(_instanceId: InstanceId, _handle: InstanceHandle, dirs: string[]): Promise<Date | null> {
		if (dirs.length === 0) return null;
		// Return a fake mtime (now) to simulate file activity
		return this.execResult.exitCode === 0 ? new Date() : null;
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
