import { createHash } from "node:crypto";
import type { InstanceId } from "@boilerhouse/core";

export interface TapDevice {
	name: string;
	ip: string;
	mac: string;
}

/**
 * Manages TAP network devices for microVM instances.
 *
 * Device names, IPs, and MACs are derived deterministically from the
 * instance ID so that the same instance always gets the same device config.
 */
export class TapManager {
	/**
	 * Returns the deterministic TAP device name for a given instance ID.
	 */
	getDeviceName(instanceId: InstanceId): string {
		return this.deriveDevice(instanceId).name;
	}

	/**
	 * Generates the shell commands needed to create a TAP device.
	 *
	 * Does not execute anything — use {@link create} for that.
	 */
	createCommands(instanceId: InstanceId): {
		commands: string[];
		device: TapDevice;
	} {
		const device = this.deriveDevice(instanceId);
		const hostIp = device.ip;
		const commands = [
			`ip tuntap add dev ${device.name} mode tap`,
			`ip addr add ${hostIp}/30 dev ${device.name}`,
			`ip link set ${device.name} up`,
		];
		return { commands, device };
	}

	/**
	 * Generates the shell commands needed to destroy a TAP device.
	 */
	destroyCommands(device: TapDevice): string[] {
		return [`ip link delete ${device.name}`];
	}

	/**
	 * Creates a TAP device by executing the generated commands.
	 */
	async create(instanceId: InstanceId): Promise<TapDevice> {
		const { commands, device } = this.createCommands(instanceId);
		for (const cmd of commands) {
			const parts = cmd.split(" ");
			const proc = Bun.spawn(parts, { stdout: "pipe", stderr: "pipe" });
			const exitCode = await proc.exited;
			if (exitCode !== 0) {
				const stderr = await new Response(proc.stderr).text();
				throw new Error(
					`TAP command failed (exit ${exitCode}): ${cmd}\n${stderr}`,
				);
			}
		}
		return device;
	}

	/**
	 * Destroys a TAP device by executing the generated commands.
	 */
	async destroy(device: TapDevice): Promise<void> {
		const commands = this.destroyCommands(device);
		for (const cmd of commands) {
			const parts = cmd.split(" ");
			const proc = Bun.spawn(parts, { stdout: "pipe", stderr: "pipe" });
			const exitCode = await proc.exited;
			if (exitCode !== 0) {
				const stderr = await new Response(proc.stderr).text();
				throw new Error(
					`TAP command failed (exit ${exitCode}): ${cmd}\n${stderr}`,
				);
			}
		}
	}

	private deriveDevice(instanceId: InstanceId): TapDevice {
		const hash = createHash("sha256")
			.update(instanceId)
			.digest();

		// TAP name: "tap-" + first 8 hex chars of hash (12 chars total, within 15-char IFNAMSIZ)
		const name = `tap-${hash.subarray(0, 4).toString("hex")}`;

		// IP: derive a /30 subnet in 172.16.0.0/12
		// 172.16.0.0/12 = 172.{16-31}.{0-255}.{0-255}
		// Use bytes 4-6 of hash. Align to /30 boundary (last 2 bits = 0), host = .1
		const secondOctet = 16 + (hash[4]! & 0x0f); // 16-31
		const thirdOctet = hash[5]!;
		const fourthOctetBase = hash[6]! & 0xfc; // /30 aligned
		const ip = `172.${secondOctet}.${thirdOctet}.${fourthOctetBase + 1}`;

		// MAC: bytes 7-12 with locally-administered bit set, unicast
		const macBytes = Buffer.from(hash.subarray(7, 13));
		macBytes[0] = (macBytes[0]! | 0x02) & 0xfe; // Set local, clear multicast
		const mac = Array.from(macBytes)
			.map((b) => b.toString(16).padStart(2, "0"))
			.join(":");

		return { name, ip, mac };
	}
}
