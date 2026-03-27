import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { DriverSocketImpl, DriverSocketError } from "./driver-socket";

let wsServer: ReturnType<typeof Bun.serve>;
let wsPort: number;

let serverHandler: (ws: { send: (msg: string) => void }, message: string) => void;
let onConnect: ((ws: { send: (msg: string) => void }) => void) | null;

beforeAll(() => {
	serverHandler = () => {};
	onConnect = null;

	wsServer = Bun.serve({
		port: 0,
		fetch(req, server) {
			if (new URL(req.url).pathname === "/ws") {
				server.upgrade(req, { data: {} });
				return undefined as unknown as Response;
			}
			return new Response("Not Found", { status: 404 });
		},
		websocket: {
			open(ws) {
				onConnect?.(ws as unknown as { send: (msg: string) => void });
			},
			message(ws, message) {
				serverHandler(ws as unknown as { send: (msg: string) => void }, String(message));
			},
		},
	});
	wsPort = wsServer.port!;
});

afterAll(() => {
	wsServer.stop(true);
});

beforeEach(() => {
	serverHandler = () => {};
	onConnect = null;
});

function connectSocket(): Promise<{ ds: DriverSocketImpl; ws: WebSocket }> {
	return new Promise((resolve) => {
		const ws = new WebSocket(`ws://localhost:${wsPort}/ws`);
		const ds = new DriverSocketImpl(ws);
		ws.onopen = () => resolve({ ds, ws });
	});
}

// ── send() ──────────────────────────────────────────────────────────────────

test("send() serializes data as JSON", async () => {
	let received: string | null = null;
	serverHandler = (_ws, message) => {
		received = message;
	};

	const { ds, ws } = await connectSocket();
	try {
		ds.send({ hello: "world" });
		// Wait for server to receive
		await new Promise((r) => setTimeout(r, 50));
		expect(received).toBe('{"hello":"world"}');
	} finally {
		ws.close();
	}
});

// ── expect() ────────────────────────────────────────────────────────────────

test("expect() resolves with next message", async () => {
	serverHandler = (ws) => {
		ws.send(JSON.stringify({ reply: "pong" }));
	};

	const { ds, ws } = await connectSocket();
	try {
		ds.send({ ping: true });
		const msg = await ds.expect();
		expect(msg).toEqual({ reply: "pong" });
	} finally {
		ws.close();
	}
});

test("expect() with match fn skips non-matching messages", async () => {
	serverHandler = (ws) => {
		ws.send(JSON.stringify({ type: "noise" }));
		ws.send(JSON.stringify({ type: "target", value: 42 }));
	};

	const { ds, ws } = await connectSocket();
	try {
		ds.send("trigger");
		const msg = (await ds.expect(
			(m) => (m as Record<string, unknown>).type === "target",
		)) as Record<string, unknown>;
		expect(msg.type).toBe("target");
		expect(msg.value).toBe(42);
	} finally {
		ws.close();
	}
});

test("expect() times out with DriverSocketError", async () => {
	// Server doesn't respond
	const { ds, ws } = await connectSocket();
	try {
		await ds.expect(undefined, 50);
		expect(true).toBe(false);
	} catch (err) {
		expect(err).toBeInstanceOf(DriverSocketError);
		expect((err as Error).message).toContain("timed out");
		expect((err as Error).message).toContain("50ms");
	} finally {
		ws.close();
	}
});

test("expect() cleans up listener on timeout", async () => {
	const { ds, ws } = await connectSocket();
	try {
		await ds.expect(undefined, 20).catch(() => {});
		// Internal listeners set should be empty after timeout
		// Send another message — no one should be listening
		expect((ds as unknown as { listeners: Set<unknown> }).listeners.size).toBe(0);
	} finally {
		ws.close();
	}
});

test("expect() cleans up listener on success", async () => {
	serverHandler = (ws) => {
		ws.send(JSON.stringify({ ok: true }));
	};

	const { ds, ws } = await connectSocket();
	try {
		ds.send("go");
		await ds.expect();
		expect((ds as unknown as { listeners: Set<unknown> }).listeners.size).toBe(0);
	} finally {
		ws.close();
	}
});

// ── collect() ───────────────────────────────────────────────────────────────

test("collect() resolves when done returns true", async () => {
	serverHandler = (ws) => {
		ws.send(JSON.stringify({ type: "chunk", n: 1 }));
		ws.send(JSON.stringify({ type: "chunk", n: 2 }));
		ws.send(JSON.stringify({ type: "done", n: 3 }));
	};

	const { ds, ws } = await connectSocket();
	try {
		ds.send("start");
		const result = (await ds.collect(
			(msg) => (msg as Record<string, unknown>).type !== undefined,
			(msg) => (msg as Record<string, unknown>).type === "done",
		)) as Record<string, unknown>;
		expect(result.type).toBe("done");
		expect(result.n).toBe(3);
	} finally {
		ws.close();
	}
});

test("collect() ignores messages where filter returns false", async () => {
	serverHandler = (ws) => {
		ws.send(JSON.stringify({ type: "noise" }));
		ws.send(JSON.stringify({ type: "relevant", final: true }));
	};

	const { ds, ws } = await connectSocket();
	try {
		ds.send("start");
		const result = (await ds.collect(
			(msg) => (msg as Record<string, unknown>).type === "relevant",
			(msg) => (msg as Record<string, unknown>).final === true,
		)) as Record<string, unknown>;
		expect(result.type).toBe("relevant");
	} finally {
		ws.close();
	}
});

test("collect() times out with DriverSocketError", async () => {
	// Server sends nothing matching
	const { ds, ws } = await connectSocket();
	try {
		await ds.collect(
			() => true,
			() => false,
			50,
		);
		expect(true).toBe(false);
	} catch (err) {
		expect(err).toBeInstanceOf(DriverSocketError);
		expect((err as Error).message).toContain("collect()");
		expect((err as Error).message).toContain("timed out");
	} finally {
		ws.close();
	}
});

test("collect() cleans up listener on success", async () => {
	serverHandler = (ws) => {
		ws.send(JSON.stringify({ done: true }));
	};

	const { ds, ws } = await connectSocket();
	try {
		ds.send("go");
		await ds.collect(() => true, (m) => (m as Record<string, unknown>).done === true);
		expect((ds as unknown as { listeners: Set<unknown> }).listeners.size).toBe(0);
	} finally {
		ws.close();
	}
});

// ── dispose() ───────────────────────────────────────────────────────────────

test("dispose() clears all listeners", async () => {
	const { ds, ws } = await connectSocket();
	try {
		// Start an expect that will never resolve
		const pending = ds.expect(undefined, 5000).catch(() => {});
		expect((ds as unknown as { listeners: Set<unknown> }).listeners.size).toBe(1);

		ds.dispose();
		expect((ds as unknown as { listeners: Set<unknown> }).listeners.size).toBe(0);

		// The pending expect won't resolve or reject cleanly — just clean up
		await Promise.race([pending, new Promise((r) => setTimeout(r, 20))]);
	} finally {
		ws.close();
	}
});

// ── JSON parse failure ──────────────────────────────────────────────────────

test("non-JSON message is passed through as raw data", async () => {
	serverHandler = (ws) => {
		ws.send("plain text not json");
	};

	const { ds, ws } = await connectSocket();
	try {
		ds.send("go");
		const msg = await ds.expect();
		expect(msg).toBe("plain text not json");
	} finally {
		ws.close();
	}
});

// ── concurrent expect and collect ───────────────────────────────────────────

test("multiple listeners receive the same message", async () => {
	serverHandler = (ws) => {
		setTimeout(() => ws.send(JSON.stringify({ shared: true })), 10);
	};

	const { ds, ws } = await connectSocket();
	try {
		ds.send("go");
		const [r1, r2] = await Promise.all([
			ds.expect(),
			ds.expect(),
		]);
		expect(r1).toEqual({ shared: true });
		expect(r2).toEqual({ shared: true });
	} finally {
		ws.close();
	}
});
