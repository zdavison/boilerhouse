import { describe, test, expect, afterEach } from "bun:test";
import type { InstanceId } from "@boilerhouse/core";
import { deriveNetnsConfig, NetnsManagerImpl } from "./netns";

const INTEGRATION = process.env.BOILERHOUSE_INTEGRATION === "1";
const IS_ROOT = process.getuid?.() === 0;

// ── Unit tests (no root required) ──────────────────────────────────────────

describe("deriveNetnsConfig", () => {
	test("deterministic — same instanceId produces same config", () => {
		const id = "inst-aaaa-bbbb-cccc-dddd" as InstanceId;
		const a = deriveNetnsConfig(id);
		const b = deriveNetnsConfig(id);

		expect(a.nsName).toBe(b.nsName);
		expect(a.tapMac).toBe(b.tapMac);
		expect(a.tapIp).toBe(b.tapIp);
		expect(a.guestIp).toBe(b.guestIp);
		expect(a.vethHostIp).toBe(b.vethHostIp);
		expect(a.vethGuestIp).toBe(b.vethGuestIp);
		expect(a.vethHostName).toBe(b.vethHostName);
		expect(a.vethGuestName).toBe(b.vethGuestName);
	});

	test("different instanceIds produce different configs", () => {
		const a = deriveNetnsConfig("inst-1111-1111-1111-1111" as InstanceId);
		const b = deriveNetnsConfig("inst-2222-2222-2222-2222" as InstanceId);

		expect(a.nsName).not.toBe(b.nsName);
		expect(a.tapIp).not.toBe(b.tapIp);
		expect(a.guestIp).not.toBe(b.guestIp);
	});

	test("TAP IPs are /30 aligned (last 2 bits of base = 0)", () => {
		const ids = [
			"inst-aaaa-0000" as InstanceId,
			"inst-bbbb-1111" as InstanceId,
			"inst-cccc-2222" as InstanceId,
			"inst-dddd-3333" as InstanceId,
		];
		for (const id of ids) {
			const config = deriveNetnsConfig(id);
			const lastOctet = Number(config.tapIp.split(".")[3]);
			// Host is base+1, so base = lastOctet - 1, base must be /30 aligned
			expect((lastOctet - 1) % 4).toBe(0);
		}
	});

	test("namespace name starts with 'fc-' and is 11 chars", () => {
		const config = deriveNetnsConfig("inst-test-ns-name" as InstanceId);
		expect(config.nsName).toMatch(/^fc-[0-9a-f]{8}$/);
		expect(config.nsName.length).toBe(11);
	});

	test("veth host name is within 15-char IFNAMSIZ limit", () => {
		const config = deriveNetnsConfig("inst-ifnamsiz-test" as InstanceId);
		// "veth-" (5) + 6 hex (6) + "-h" (2) = 13
		expect(config.vethHostName.length).toBeLessThanOrEqual(15);
		expect(config.vethHostName).toMatch(/^veth-[0-9a-f]{6}-h$/);
	});

	test("veth guest name is within 15-char IFNAMSIZ limit", () => {
		const config = deriveNetnsConfig("inst-ifnamsiz-test" as InstanceId);
		// "veth-" (5) + 6 hex (6) + "-g" (2) = 13
		expect(config.vethGuestName.length).toBeLessThanOrEqual(15);
		expect(config.vethGuestName).toMatch(/^veth-[0-9a-f]{6}-g$/);
	});

	test("TAP MAC has locally-administered bit set, unicast", () => {
		const config = deriveNetnsConfig("inst-mac-check" as InstanceId);
		const firstByte = Number.parseInt(config.tapMac.split(":")[0]!, 16);
		// Locally administered: bit 1 of first byte set
		expect(firstByte & 0x02).toBe(0x02);
		// Unicast: bit 0 of first byte clear
		expect(firstByte & 0x01).toBe(0x00);
	});

	test("veth IPs use 10.0.x.x/30 range", () => {
		const config = deriveNetnsConfig("inst-veth-ip-test" as InstanceId);
		expect(config.vethHostIp).toMatch(/^10\.0\.\d+\.\d+$/);
		expect(config.vethGuestIp).toMatch(/^10\.0\.\d+\.\d+$/);
	});

	test("guest IP is TAP base + 2", () => {
		const config = deriveNetnsConfig("inst-guest-ip-calc" as InstanceId);
		const tapParts = config.tapIp.split(".").map(Number);
		const guestParts = config.guestIp.split(".").map(Number);
		// TAP host is base+1, guest is base+2
		expect(guestParts[3]).toBe(tapParts[3]! + 1);
		expect(guestParts[0]).toBe(tapParts[0]);
		expect(guestParts[1]).toBe(tapParts[1]);
		expect(guestParts[2]).toBe(tapParts[2]);
	});
});

// ── Integration tests (root + BOILERHOUSE_INTEGRATION=1) ──────────────────

describe.skipIf(!INTEGRATION || !IS_ROOT)("NetnsManagerImpl integration", () => {
	const manager = new NetnsManagerImpl();
	const createdHandles: { nsName: string }[] = [];

	afterEach(async () => {
		for (const handle of createdHandles) {
			try {
				await manager.destroy({
					nsName: handle.nsName,
					nsPath: `/var/run/netns/${handle.nsName}`,
					tapName: "tap0",
					tapIp: "",
					tapMac: "",
					vethHostIp: "",
					guestIp: "",
					vethHostName: "",
				});
			} catch {
				// Best-effort cleanup
			}
		}
		createdHandles.length = 0;
	});

	test("create + list shows namespace", async () => {
		const instanceId = "inst-integ-ns-test" as InstanceId;
		const handle = await manager.create(instanceId, 200000);
		createdHandles.push(handle);

		const nsList = await manager.list();
		expect(nsList).toContain(handle.nsName);
	});

	test("create + destroy removes namespace", async () => {
		const instanceId = "inst-integ-ns-destroy" as InstanceId;
		const handle = await manager.create(instanceId, 200000);

		await manager.destroy(handle);

		const nsList = await manager.list();
		expect(nsList).not.toContain(handle.nsName);
	});
});
