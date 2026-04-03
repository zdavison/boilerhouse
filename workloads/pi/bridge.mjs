/**
 * Pi bridge server — single-tenant.
 *
 * Spawns `pi --mode rpc` on startup with baked-in skills.
 * Bridges WebSocket messages to Pi's stdin/stdout JSONL protocol.
 *
 * Protocol:
 *   Client → Bridge:
 *     { type: "prompt", text: string }
 *
 *   Bridge → Client:
 *     { type: "output", text: string }
 *     { type: "idle" }
 *     { type: "exit", code: number }
 *     { type: "error", message: string }
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";

const require = createRequire(import.meta.url);
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.BRIDGE_PORT ?? 7880);
const PI_MODEL = process.env.PI_MODEL ?? "sonnet";
const PI_PROVIDER = process.env.PI_PROVIDER ?? "anthropic";
const SKILLS_DIR = process.env.SKILLS_DIR ?? "/skills";

// ── Skill discovery ───────────────────────────────────────────────────

function discoverSkills(dir) {
	try {
		return readdirSync(dir)
			.filter((entry) => {
				try {
					return statSync(join(dir, entry)).isDirectory();
				} catch {
					return false;
				}
			})
			.map((entry) => join(dir, entry));
	} catch {
		console.log(`[bridge] No skills directory at ${dir}`);
		return [];
	}
}

// ── Pi RPC subprocess ─────────────────────────────────────────────────

const skillPaths = discoverSkills(SKILLS_DIR);
console.log(`[bridge] Discovered ${skillPaths.length} skills:`, skillPaths);

const piArgs = ["--mode", "rpc", "--model", PI_MODEL, "--provider", PI_PROVIDER];
for (const skillPath of skillPaths) {
	piArgs.push("--skill", skillPath);
}

console.log(`[bridge] Starting: pi ${piArgs.join(" ")}`);

let pi = null;
let piReady = false;
let piStdoutReader = null;

/** @type {Set<import("ws").WebSocket>} */
const sockets = new Set();

/** @type {object | null} — non-null while a prompt is in flight */
let pendingPrompt = null;

function broadcast(message) {
	const data = JSON.stringify(message);
	for (const ws of sockets) {
		if (ws.readyState === 1) {
			ws.send(data);
		}
	}
}

function startPi() {
	pi = spawn("pi", piArgs, {
		stdio: ["pipe", "pipe", "pipe"],
		env: process.env,
	});

	pi.on("error", (err) => {
		console.error(`[bridge] Failed to spawn pi:`, err.message);
		broadcast({ type: "error", message: `Failed to spawn pi: ${err.message}` });
		piReady = false;
	});

	pi.stderr.on("data", (chunk) => {
		console.error(`[bridge] pi stderr: ${chunk.toString().trim()}`);
	});

	// Read Pi's stdout as line-delimited JSON
	piStdoutReader = createInterface({ input: pi.stdout });
	piStdoutReader.on("line", (line) => {
		if (!line.trim()) return;

		let msg;
		try {
			msg = JSON.parse(line);
		} catch {
			console.error(`[bridge] Non-JSON from pi stdout: ${line}`);
			return;
		}

		handlePiEvent(msg);
	});

	pi.on("exit", (code) => {
		console.error(`[bridge] Pi exited with code ${code}`);
		piReady = false;
		broadcast({ type: "exit", code: code ?? 1 });

		pendingPrompt = null;
	});

	piReady = true;
	console.log(`[bridge] Pi subprocess started`);
}

function handlePiEvent(msg) {
	// Pi RPC protocol:
	//   "response" — ack for a command (prompt, abort, etc.)
	//   "message_update" — streaming content, contains assistantMessageEvent
	//   "agent_end" — agent finished processing
	//   "turn_end" — single turn complete
	//   Other events (agent_start, turn_start, message_start, message_end,
	//     tool_execution_*, compaction_*, queue_update) are informational.

	if (msg.type === "response") {
		if (!msg.success) {
			broadcast({ type: "error", message: msg.error ?? "Unknown error" });
			pendingPrompt = null;
		}
		// success responses are just acks, content comes via events
		return;
	}

	if (msg.type === "message_update") {
		const evt = msg.assistantMessageEvent;
		if (evt?.type === "text_delta" && evt.delta) {
			broadcast({ type: "output", text: evt.delta });
		}
		return;
	}

	if (msg.type === "agent_end" || msg.type === "turn_end") {
		broadcast({ type: "idle" });
		pendingPrompt = null;
		return;
	}

	if (msg.type === "message_start" || msg.type === "message_end" ||
		msg.type === "agent_start" || msg.type === "turn_start" ||
		msg.type === "tool_execution_start" || msg.type === "tool_execution_end" ||
		msg.type === "tool_execution_update" ||
		msg.type === "compaction_start" || msg.type === "compaction_end" ||
		msg.type === "queue_update") {
		// Informational — ignore
		return;
	}

	console.log(`[bridge] Unhandled pi event: ${JSON.stringify(msg)}`);
}

function sendToPi(command) {
	if (!pi || !piReady) {
		broadcast({ type: "error", message: "Pi is not running" });
		return;
	}
	const line = JSON.stringify(command) + "\n";
	pi.stdin.write(line);
}

startPi();

// ── HTTP + WebSocket server ───────────────────────────────────────────

const server = createServer((req, res) => {
	if (req.url === "/health") {
		const status = piReady ? 200 : 503;
		res.writeHead(status, { "Content-Type": "text/plain" });
		res.end(piReady ? "ok" : "pi not ready");
		return;
	}
	res.writeHead(404);
	res.end("Not Found");
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
	console.log("[bridge] WebSocket connection opened");
	sockets.add(ws);

	ws.on("message", (raw) => {
		let msg;
		try {
			msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
		} catch {
			ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
			return;
		}

		if (msg.type === "prompt") {
			if (!msg.text) {
				ws.send(JSON.stringify({ type: "error", message: "Missing text" }));
				return;
			}
			if (pendingPrompt) {
				ws.send(JSON.stringify({ type: "error", message: "Already processing a prompt" }));
				return;
			}
			console.log(`[bridge] Prompt: ${msg.text.slice(0, 80)}`);
			pendingPrompt = {};
			sendToPi({ type: "prompt", message: msg.text });
			return;
		}

		ws.send(JSON.stringify({ type: "error", message: `Unknown message type: ${msg.type}` }));
	});

	ws.on("close", () => {
		sockets.delete(ws);
		console.log("[bridge] WebSocket connection closed");
	});
});

server.listen(PORT, () => {
	console.log(`Pi bridge listening on port ${PORT}`);
});
