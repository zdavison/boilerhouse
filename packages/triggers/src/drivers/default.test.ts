import { test, expect } from "bun:test";
import { defaultDriver } from "./default";
import type { DriverSocket, DriverEndpoint, DriverConfig, SendContext } from "../driver";

function mockDriverEndpoint(
	expectReturn: unknown = { echo: true },
): { endpoint: DriverEndpoint; sent: unknown[] } {
	const sent: unknown[] = [];
	const ds: DriverSocket = {
		send(data) {
			sent.push(data);
		},
		expect() {
			return Promise.resolve(expectReturn);
		},
		collect() {
			return Promise.resolve(null);
		},
		raw: null as unknown as WebSocket,
	};
	return { endpoint: { httpUrl: "http://localhost:9999", ws: ds }, sent };
}

const ctx: SendContext = {
	tenantId: "t-1",
	triggerName: "test",
	eventId: "evt-1",
};

const cfg: DriverConfig = { options: {} };

test("send() forwards payload via ws.send and returns ws.expect result", async () => {
	const { endpoint, sent } = mockDriverEndpoint({ reply: "pong" });
	const result = await defaultDriver.send(endpoint, { text: "hello" }, ctx, cfg);
	expect(sent).toEqual([{ text: "hello" }]);
	expect(result).toEqual({ reply: "pong" });
});

test("send() returns whatever expect() resolves with", async () => {
	const { endpoint } = mockDriverEndpoint("raw string");
	const result = await defaultDriver.send(endpoint, {}, ctx, cfg);
	expect(result).toBe("raw string");
});

test("defaultDriver has no handshake", () => {
	expect(defaultDriver.handshake).toBeUndefined();
});
