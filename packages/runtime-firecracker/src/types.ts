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
	/** Recreates a TAP device with a specific config (for snapshot restore). */
	createFromDevice(device: TapDevice): Promise<TapDevice>;
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

// ── Jailer types ───────────────────────────────────────────────────────────

export interface JailerConfig {
	/**
	 * Path to the jailer binary.
	 * @default "/usr/local/bin/jailer"
	 */
	jailerPath: string;
	/**
	 * Base directory for chroot jails.
	 * @default "/srv/jailer"
	 */
	chrootBaseDir: string;
	/**
	 * Start of the UID range for per-VM isolation.
	 * @default 100000
	 */
	uidRangeStart: number;
	/**
	 * GID for all jailed processes.
	 * @default 100000
	 */
	gid: number;
	/**
	 * Whether the jailer should daemonize.
	 * @default true
	 */
	daemonize: boolean;
	/**
	 * Whether to create a new PID namespace.
	 * @default true
	 */
	newPidNs: boolean;
	/**
	 * Cgroup version to use.
	 * @default 2
	 */
	cgroupVersion: 1 | 2;
}

export interface NetnsHandle {
	/** Network namespace name, e.g. "fc-a1b2c3d4". */
	nsName: string;
	/**
	 * Path to the namespace in /var/run/netns/.
	 * @example "/var/run/netns/fc-a1b2c3d4"
	 */
	nsPath: string;
	/** TAP device name inside the namespace. */
	tapName: string;
	/** TAP device IP (gateway for the guest). */
	tapIp: string;
	/** MAC address of the TAP device. */
	tapMac: string;
	/** Host-side IP on the veth pair. */
	vethHostIp: string;
	/** Guest IP derived for the VM. */
	guestIp: string;
	/**
	 * Host-side veth interface name.
	 * @example "veth-a1b2c3-h"
	 */
	vethHostName: string;
}

export interface JailPaths {
	/**
	 * Chroot root directory.
	 * @example "/srv/jailer/firecracker/inst-abc123/root"
	 */
	chrootRoot: string;
	/** Host-side API socket path. */
	apiSocket: string;
	/**
	 * Kernel path relative to chroot root.
	 * @example "vmlinux"
	 */
	kernelRelative: string;
	/**
	 * Rootfs path relative to chroot root.
	 * @example "rootfs.ext4"
	 */
	rootfsRelative: string;
	/** Log file path outside the chroot. */
	logPath: string;
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
	/**
	 * TAP device manager for network setup (dev mode).
	 * Required when `jailer` is not set.
	 */
	tapManager?: TapManager;
	/**
	 * Jailer configuration for production isolation.
	 * When set, the runtime uses jailer-based spawning with network namespaces.
	 */
	jailer?: JailerConfig;
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
	/**
	 * Base directory where rootfs images are stored.
	 * Image refs are resolved to paths within this directory:
	 * `alpine/openclaw:main` → `<imagesDir>/alpine/openclaw/main/rootfs.ext4`
	 * @example "/var/lib/boilerhouse/images"
	 */
	imagesDir: string;
}
