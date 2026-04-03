import { describe, test, expect, afterEach } from "bun:test";
import type { InstanceId, TenantId, WorkloadId } from "@boilerhouse/core";
import { createTestApp } from "../test-helpers";
import type { DomainEvent } from "@boilerhouse/domain";

function waitForMessage(ws: WebSocket): Promise<string> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => reject(new Error("WS message timeout")), 2000);
		ws.addEventListener(
			"message",
			(event) => {
				clearTimeout(timeout);
				resolve(event.data as string);
			},
			{ once: true },
		);
	});
}

function waitForOpen(ws: WebSocket): Promise<void> {
	return new Promise((resolve, reject) => {
		if (ws.readyState === WebSocket.OPEN) {
			resolve();
			return;
		}
		const timeout = setTimeout(() => reject(new Error("WS open timeout")), 2000);
		ws.addEventListener(
			"open",
			() => {
				clearTimeout(timeout);
				resolve();
			},
			{ once: true },
		);
	});
}

describe("WebSocket /ws", () => {
	let serverInstance: ReturnType<ReturnType<typeof createTestApp>["app"]["listen"]> | null =
		null;
	const openSockets: WebSocket[] = [];

	afterEach(() => {
		for (const ws of openSockets) {
			if (ws.readyState === WebSocket.OPEN) ws.close();
		}
		openSockets.length = 0;
		if (serverInstance) {
			serverInstance.stop(true);
			serverInstance = null;
		}
	});

	function startServer() {
		const ctx = createTestApp();
		serverInstance = ctx.app.listen(0);
		const port = serverInstance.server!.port as number;
		return { ctx, port };
	}

	function connect(port: number): WebSocket {
		const ws = new WebSocket(`ws://localhost:${port}/ws`);
		openSockets.push(ws);
		return ws;
	}

	test("client receives instance state events", async () => {
		const { ctx, port } = startServer();

		const ws = connect(port);
		await waitForOpen(ws);

		const msgPromise = waitForMessage(ws);

		const event: DomainEvent = {
			type: "instance.state",
			instanceId: "inst-1" as InstanceId,
			status: "active",
		};
		ctx.eventBus.emit(event);

		const raw = await msgPromise;
		const received = JSON.parse(raw);

		expect(received.type).toBe("instance.state");
		expect(received.instanceId).toBe("inst-1");
		expect(received.status).toBe("active");
	});

	test("client receives tenant events", async () => {
		const { ctx, port } = startServer();

		const ws = connect(port);
		await waitForOpen(ws);

		const msgPromise = waitForMessage(ws);

		ctx.eventBus.emit({
			type: "tenant.claimed",
			tenantId: "t-1" as TenantId,
			instanceId: "i-1" as InstanceId,
			workloadId: "w-1" as WorkloadId,
			source: "golden",
		});

		const raw = await msgPromise;
		const received = JSON.parse(raw);

		expect(received.type).toBe("tenant.claimed");
		expect(received.tenantId).toBe("t-1");
	});

	test("multiple clients receive the same event", async () => {
		const { ctx, port } = startServer();

		const ws1 = connect(port);
		const ws2 = connect(port);
		await Promise.all([waitForOpen(ws1), waitForOpen(ws2)]);

		const msg1 = waitForMessage(ws1);
		const msg2 = waitForMessage(ws2);

		ctx.eventBus.emit({
			type: "instance.state",
			instanceId: "inst-1" as InstanceId,
			status: "destroyed",
		});

		const [raw1, raw2] = await Promise.all([msg1, msg2]);
		expect(JSON.parse(raw1).instanceId).toBe("inst-1");
		expect(JSON.parse(raw2).instanceId).toBe("inst-1");
	});

	test("disconnect cleans up listener", async () => {
		const { ctx, port } = startServer();

		const ws = connect(port);
		await waitForOpen(ws);

		expect(ctx.eventBus.listenerCount()).toBe(1);

		ws.close();
		// Give Elysia time to process the close
		await new Promise((r) => setTimeout(r, 100));

		expect(ctx.eventBus.listenerCount()).toBe(0);
	});
});
