import type { InstanceId, NodeId } from "@boilerhouse/core";

// ── TAP device interfaces ───────────────────────────────────────────────────
// Defined locally to avoid depending on apps/api. The concrete TapManager
// from apps/api satisfies this interface at the call site.

export interface TapDevice {
	name: string;
	ip: string;
	mac: string;
}

export interface TapManager {
	create(instanceId: InstanceId): Promise<TapDevice>;
	destroy(device: TapDevice): Promise<void>;
}

// ── Sub-types ───────────────────────────────────────────────────────────────

export interface TokenBucket {
	size: number;
	one_time_burst?: number;
	refill_time: number;
}

export interface RateLimiter {
	bandwidth?: TokenBucket;
	ops?: TokenBucket;
}

// ── CPU template ────────────────────────────────────────────────────────────

export type CpuTemplate = "C3" | "T2" | "T2S" | "T2CL" | "T2A" | "V1N1" | "None";

// ── Request types ───────────────────────────────────────────────────────────

export interface BootSourceRequest {
	kernel_image_path: string;
	boot_args?: string;
	initrd_path?: string;
}

export interface MachineConfigRequest {
	vcpu_count: number;
	mem_size_mib: number;
	smt?: boolean;
	cpu_template?: CpuTemplate;
	track_dirty_pages?: boolean;
}

export interface DriveRequest {
	drive_id: string;
	path_on_host: string;
	is_root_device: boolean;
	is_read_only: boolean;
	rate_limiter?: RateLimiter;
}

export interface NetworkInterfaceRequest {
	iface_id: string;
	host_dev_name: string;
	guest_mac?: string;
	rx_rate_limiter?: RateLimiter;
	tx_rate_limiter?: RateLimiter;
}

export type ActionType = "InstanceStart" | "SendCtrlAltDel" | "FlushMetrics";

export interface ActionRequest {
	action_type: ActionType;
}

export type VmState = "Paused" | "Resumed";

export interface VmUpdateRequest {
	state: VmState;
}

export type SnapshotType = "Full" | "Diff";

export interface SnapshotCreateRequest {
	snapshot_type: SnapshotType;
	snapshot_path: string;
	mem_file_path: string;
}

export interface SnapshotLoadRequest {
	snapshot_path: string;
	mem_file_path: string;
	enable_diff_snapshots?: boolean;
	resume_vm?: boolean;
}

// ── Response types ──────────────────────────────────────────────────────────

export interface InstanceInfoResponse {
	id: string;
	state: string;
	vmm_version: string;
	app_name: string;
}

export interface MachineConfigResponse {
	vcpu_count: number;
	mem_size_mib: number;
	smt: boolean;
	cpu_template: CpuTemplate;
	track_dirty_pages: boolean;
}

export interface FirecrackerErrorBody {
	fault_message: string;
}

// ── Config ──────────────────────────────────────────────────────────────────

export interface FirecrackerConfig {
	/** Path to the Firecracker binary. */
	binaryPath: string;
	/** Path to the guest kernel image. */
	kernelPath: string;
	/** Base directory for snapshot storage. */
	snapshotDir: string;
	/** Base directory for instance working directories. */
	instanceDir: string;
	/** Node ID of the host running this runtime. */
	nodeId: NodeId;
	/** TAP device manager for network setup. */
	tapManager: TapManager;
	/**
	 * Kernel boot arguments.
	 * @default "console=ttyS0 reboot=k panic=1 pci=off"
	 */
	bootArgs?: string;
	/**
	 * CPU template for snapshot compatibility.
	 * @default "None"
	 */
	cpuTemplate?: CpuTemplate;
}
