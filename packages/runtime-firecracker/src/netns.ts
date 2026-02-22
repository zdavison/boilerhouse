import { createHash } from "node:crypto";
import type { InstanceId } from "@boilerhouse/core";
import type { NetnsHandle } from "./types";
import { NetnsError } from "./errors";

/**
 * Derived network configuration for a namespace.
 * Returned by {@link deriveNetnsConfig} for deterministic IP/MAC/name assignment.
 */
export interface DerivedNetnsConfig {
	nsName: string;
	tapIp: string;
	tapMac: string;
	guestIp: string;
	vethHostIp: string;
	vethGuestIp: string;
	vethHostName: string;
	vethGuestName: string;
}

/**
 * Derives deterministic network namespace configuration from an instance ID.
 *
 * Uses SHA256 of the instance ID to produce:
 * - Namespace name: "fc-" + first 8 hex chars
 * - TAP IP: 172.16.x.x/30 (bytes 4-6, /30 aligned, host = base+1)
 * - Guest IP: TAP base + 2
 * - TAP MAC: bytes 7-12, locally-administered unicast
 * - Veth host IP: 10.0.x.x/30 (bytes 13-15, /30 aligned, host = base+1)
 * - Veth guest IP: veth base + 2
 * - Veth names: "veth-{6hex}-h" / "veth-{6hex}-g" (bytes 16-18)
 */
export function deriveNetnsConfig(instanceId: InstanceId): DerivedNetnsConfig {
	const hash = createHash("sha256").update(instanceId).digest();

	// Namespace name: "fc-" + first 8 hex chars of hash
	const nsName = `fc-${hash.subarray(0, 4).toString("hex")}`;

	// TAP IP: 172.16.x.x/30 range (same scheme as tap.ts)
	const secondOctet = 16 + (hash[4]! & 0x0f); // 16-31
	const thirdOctet = hash[5]!;
	const fourthOctetBase = hash[6]! & 0xfc; // /30 aligned
	const tapIp = `172.${secondOctet}.${thirdOctet}.${fourthOctetBase + 1}`;
	const guestIp = `172.${secondOctet}.${thirdOctet}.${fourthOctetBase + 2}`;

	// TAP MAC: bytes 7-12, locally-administered unicast
	const macBytes = Buffer.from(hash.subarray(7, 13));
	macBytes[0] = (macBytes[0]! | 0x02) & 0xfe;
	const tapMac = Array.from(macBytes)
		.map((b) => b.toString(16).padStart(2, "0"))
		.join(":");

	// Veth IPs: 10.0.x.x/30 range (bytes 13-15)
	const vethThirdOctet = hash[13]!;
	const vethFourthBase = hash[14]! & 0xfc; // /30 aligned
	const vethHostIp = `10.0.${vethThirdOctet}.${vethFourthBase + 1}`;
	const vethGuestIp = `10.0.${vethThirdOctet}.${vethFourthBase + 2}`;

	// Veth names: "veth-{6hex}-h" / "veth-{6hex}-g" (13 chars, within IFNAMSIZ 15)
	const vethHash = hash.subarray(16, 19).toString("hex");
	const vethHostName = `veth-${vethHash}-h`;
	const vethGuestName = `veth-${vethHash}-g`;

	return {
		nsName,
		tapIp,
		tapMac,
		guestIp,
		vethHostIp,
		vethGuestIp,
		vethHostName,
		vethGuestName,
	};
}

/** Execute a command via sudo and throw NetnsError on failure. */
async function sudoExec(args: string[], context: string): Promise<void> {
	const proc = Bun.spawn(["sudo", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const exitCode = await proc.exited;
	if (exitCode !== 0) {
		const stderr = await new Response(proc.stderr).text();
		throw new NetnsError(`${context}: ${stderr.trim()} (exit ${exitCode})`);
	}
}

/**
 * Manages Linux network namespaces for jailer-based VM isolation.
 *
 * Each VM gets its own network namespace containing a TAP device and a veth
 * pair for host connectivity. IP masquerading (NAT) is configured on the host.
 */
export class NetnsManagerImpl {
	/**
	 * Creates a network namespace with TAP device and veth pair.
	 *
	 * @param instanceId - Instance ID for deterministic network config
	 * @param uid - UID of the jailed process (for TAP device ownership)
	 */
	async create(instanceId: InstanceId, uid: number): Promise<NetnsHandle> {
		const config = deriveNetnsConfig(instanceId);
		const { nsName, tapIp, tapMac, guestIp, vethHostIp, vethGuestIp, vethHostName, vethGuestName } = config;

		// 1. Create namespace
		await sudoExec(["ip", "netns", "add", nsName], `Failed to create namespace ${nsName}`);

		try {
			// 2. Create TAP device inside namespace
			await sudoExec(
				["ip", "netns", "exec", nsName, "ip", "tuntap", "add", "name", "tap0", "mode", "tap", "user", String(uid)],
				`Failed to create TAP in ${nsName}`,
			);

			// 3. Configure TAP IP
			await sudoExec(
				["ip", "netns", "exec", nsName, "ip", "addr", "add", `${tapIp}/30`, "dev", "tap0"],
				`Failed to set TAP IP in ${nsName}`,
			);

			// 4. Bring TAP up
			await sudoExec(
				["ip", "netns", "exec", nsName, "ip", "link", "set", "tap0", "up"],
				`Failed to bring up TAP in ${nsName}`,
			);

			// 5. Create veth pair, putting guest end into the namespace
			await sudoExec(
				["ip", "link", "add", vethHostName, "type", "veth", "peer", "name", vethGuestName, "netns", nsName],
				`Failed to create veth pair for ${nsName}`,
			);

			// 6. Configure host-side veth
			await sudoExec(
				["ip", "addr", "add", `${vethHostIp}/30`, "dev", vethHostName],
				`Failed to set host veth IP for ${nsName}`,
			);
			await sudoExec(
				["ip", "link", "set", vethHostName, "up"],
				`Failed to bring up host veth for ${nsName}`,
			);

			// 7. Configure namespace-side veth
			await sudoExec(
				["ip", "netns", "exec", nsName, "ip", "addr", "add", `${vethGuestIp}/30`, "dev", vethGuestName],
				`Failed to set guest veth IP in ${nsName}`,
			);
			await sudoExec(
				["ip", "netns", "exec", nsName, "ip", "link", "set", vethGuestName, "up"],
				`Failed to bring up guest veth in ${nsName}`,
			);
			await sudoExec(
				["ip", "netns", "exec", nsName, "ip", "route", "add", "default", "via", vethHostIp],
				`Failed to add default route in ${nsName}`,
			);

			// 8. iptables NAT + forwarding rules
			await sudoExec(
				["iptables", "-t", "nat", "-A", "POSTROUTING", "-s", `${vethGuestIp}/30`, "-o", "eth0", "-j", "MASQUERADE"],
				`Failed to add NAT rule for ${nsName}`,
			);
			await sudoExec(
				["iptables", "-A", "FORWARD", "-i", vethHostName, "-j", "ACCEPT"],
				`Failed to add FORWARD rule (out) for ${nsName}`,
			);
			await sudoExec(
				["iptables", "-A", "FORWARD", "-o", vethHostName, "-m", "state", "--state", "RELATED,ESTABLISHED", "-j", "ACCEPT"],
				`Failed to add FORWARD rule (in) for ${nsName}`,
			);
		} catch (err) {
			// Attempt cleanup on partial creation failure
			try {
				await sudoExec(["ip", "netns", "delete", nsName], "cleanup");
			} catch {
				// Ignore cleanup errors
			}
			throw err;
		}

		return {
			nsName,
			nsPath: `/var/run/netns/${nsName}`,
			tapName: "tap0",
			tapIp,
			tapMac,
			vethHostIp,
			guestIp,
			vethHostName,
		};
	}

	/** Destroys a network namespace and associated iptables rules. */
	async destroy(handle: NetnsHandle): Promise<void> {
		const { nsName, vethHostName, vethHostIp } = handle;

		// Remove iptables rules (best-effort, ignore errors)
		const vethGuestIp = vethHostIp.replace(
			/\.(\d+)$/,
			(_, last) => `.${Number(last) + 1}`,
		);

		try {
			await sudoExec(
				["iptables", "-t", "nat", "-D", "POSTROUTING", "-s", `${vethGuestIp}/30`, "-o", "eth0", "-j", "MASQUERADE"],
				"remove NAT",
			);
		} catch {
			// Best-effort
		}

		try {
			await sudoExec(
				["iptables", "-D", "FORWARD", "-i", vethHostName, "-j", "ACCEPT"],
				"remove FORWARD out",
			);
		} catch {
			// Best-effort
		}

		try {
			await sudoExec(
				["iptables", "-D", "FORWARD", "-o", vethHostName, "-m", "state", "--state", "RELATED,ESTABLISHED", "-j", "ACCEPT"],
				"remove FORWARD in",
			);
		} catch {
			// Best-effort
		}

		// Delete host-side veth (peer auto-deleted with namespace)
		try {
			await sudoExec(["ip", "link", "delete", vethHostName], "delete host veth");
		} catch {
			// May already be gone if namespace deletion beats us
		}

		// Delete namespace
		await sudoExec(
			["ip", "netns", "delete", nsName],
			`Failed to delete namespace ${nsName}`,
		);
	}

	/**
	 * Best-effort cleanup of a namespace by name only.
	 *
	 * Deleting the namespace destroys all interfaces inside it (including the
	 * guest-side veth), which causes the kernel to auto-remove the host-side
	 * veth peer as well. Iptables rules referencing the now-gone veth become
	 * inert (they match nothing) and are harmless until manually pruned.
	 */
	async destroyByName(nsName: string): Promise<void> {
		try {
			await sudoExec(
				["ip", "netns", "delete", nsName],
				`Failed to delete namespace ${nsName}`,
			);
		} catch {
			// Namespace may already be gone
		}
	}

	/** Lists all fc-* network namespaces. */
	async list(): Promise<string[]> {
		const proc = Bun.spawn(["ip", "netns", "list"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			const stderr = await new Response(proc.stderr).text();
			throw new NetnsError(`Failed to list namespaces: ${stderr.trim()}`);
		}

		const stdout = await new Response(proc.stdout).text();
		return stdout
			.split("\n")
			.map((line) => line.split(" ")[0]!.trim())
			.filter((name) => name.startsWith("fc-"));
	}
}
