/**
 * Claude Code bridge server.
 *
 * HTTP health endpoint + WebSocket bridge. Each prompt spawns
 * `claude --print --output-format json`. The first prompt creates a
 * new conversation; subsequent prompts use `--resume <session_id>`
 * for multi-turn continuity.
 *
 * Protocol:
 *   Client → Server:
 *     { type: "init", tenantId: string }   — register tenant
 *     { type: "prompt", text: string }      — run claude --print
 *
 *   Server → Client:
 *     { type: "ready" }                     — tenant registered
 *     { type: "output", text: string }      — response text from claude
 *     { type: "idle" }                      — claude finished (ready for next)
 *     { type: "exit", code: number }        — claude exited with error
 *     { type: "error", message: string }    — bridge-level error
 */

import { createServer } from "node:http";
import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { WebSocketServer } = require("ws");

const PORT = Number(process.env.BRIDGE_PORT ?? 7880);
const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? "sonnet";
const WORKSPACE = process.env.WORKSPACE_DIR ?? "/workspace";

// ── Tenant state ──────────────────────────────────────────────────────

/** @type {Map<string, { sessionId: string | null, sockets: Set<import("ws").WebSocket>, busy: boolean }>} */
const tenants = new Map();

function ensureTenantDir(tenantId) {
	const dir = `${WORKSPACE}/${tenantId}`;
	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
		execSync("git init", { cwd: dir, stdio: "ignore" });
	}
	return dir;
}

/** Path to persisted session ID for a tenant (survives hibernate). */
function sessionFilePath(tenantId) {
	return `${WORKSPACE}/${tenantId}/.bridge-session`;
}

function loadSessionId(tenantId) {
	try {
		return readFileSync(sessionFilePath(tenantId), "utf-8").trim() || null;
	} catch {
		return null;
	}
}

function saveSessionId(tenantId, sessionId) {
	try {
		ensureTenantDir(tenantId);
		writeFileSync(sessionFilePath(tenantId), sessionId);
	} catch (err) {
		console.error(`[bridge] Failed to save session ID for ${tenantId}:`, err.message);
	}
}

function getTenant(tenantId) {
	let tenant = tenants.get(tenantId);
	if (!tenant) {
		const sessionId = loadSessionId(tenantId);
		tenant = { sessionId, sockets: new Set(), busy: false };
		tenants.set(tenantId, tenant);
		if (sessionId) {
			console.log(`[bridge] Restored session ${sessionId} for ${tenantId} from disk`);
		}
	}
	return tenant;
}

function broadcast(tenant, message) {
	const data = JSON.stringify(message);
	for (const ws of tenant.sockets) {
		if (ws.readyState === 1 /* OPEN */) {
			ws.send(data);
		}
	}
}

/**
 * Run `claude --print --output-format json` for a single prompt.
 * Uses --resume on subsequent calls for conversation continuity.
 */
function runPrompt(tenantId, text) {
	const tenant = getTenant(tenantId);
	if (tenant.busy) {
		broadcast(tenant, { type: "error", message: "Already processing a prompt" });
		return;
	}

	tenant.busy = true;
	const cwd = ensureTenantDir(tenantId);

	const args = [
		"--print",
		"--output-format", "json",
		"--dangerously-skip-permissions",
		"--model", CLAUDE_MODEL,
	];

	if (tenant.sessionId) {
		args.push("--resume", tenant.sessionId);
	}

	args.push(text);

	console.log(`[bridge] Running prompt for ${tenantId} (session: ${tenant.sessionId ?? "new"})`);

	const proc = spawn("claude", args, {
		cwd,
		env: process.env,
		stdio: ["ignore", "pipe", "pipe"],
	});

	let stdout = "";
	let stderr = "";

	proc.on("error", (err) => {
		console.error(`[bridge] Failed to spawn claude for ${tenantId}:`, err.message);
		broadcast(tenant, { type: "error", message: err.message });
		tenant.busy = false;
	});

	proc.stdout.on("data", (chunk) => {
		stdout += chunk.toString();
	});

	proc.stderr.on("data", (chunk) => {
		const text = chunk.toString().trim();
		stderr += chunk.toString();
		console.error(`[bridge] claude stderr (${tenantId}): ${text}`);
	});

	proc.on("exit", (code) => {
		console.log(`[bridge] claude --print exited for ${tenantId} with code ${code}`);
		tenant.busy = false;

		if (code === 0) {
			try {
				const result = JSON.parse(stdout);
				// Capture session_id for conversation continuity
				if (result.session_id) {
					tenant.sessionId = result.session_id;
					saveSessionId(tenantId, result.session_id);
					console.log(`[bridge] Session ID for ${tenantId}: ${tenant.sessionId}`);
				}
				const responseText = result.result ?? stdout;
				broadcast(tenant, { type: "output", text: responseText });
			} catch {
				// If JSON parse fails, send raw stdout
				broadcast(tenant, { type: "output", text: stdout });
			}
			broadcast(tenant, { type: "idle" });
		} else {
			broadcast(tenant, { type: "exit", code: code ?? 1, stderr: stderr.trim() });
		}
	});
}

// ── HTTP + WebSocket server ───────────────────────────────────────────

const server = createServer((req, res) => {
	if (req.url === "/health") {
		res.writeHead(200, { "Content-Type": "text/plain" });
		res.end("ok");
		return;
	}
	res.writeHead(404);
	res.end("Not Found");
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
	console.log("[bridge] WebSocket connection opened");
	let tenantId = null;

	ws.on("message", (raw) => {
		let msg;
		try {
			msg = JSON.parse(typeof raw === "string" ? raw : raw.toString());
		} catch {
			ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
			return;
		}

		if (msg.type === "init") {
			if (!msg.tenantId) {
				ws.send(JSON.stringify({ type: "error", message: "Missing tenantId" }));
				return;
			}
			tenantId = msg.tenantId;
			const tenant = getTenant(tenantId);
			tenant.sockets.add(ws);
			console.log(`[bridge] Tenant ${tenantId} initialized (session: ${tenant.sessionId ?? "none yet"})`);
			ws.send(JSON.stringify({ type: "ready" }));
			return;
		}

		if (msg.type === "prompt") {
			if (!tenantId) {
				ws.send(JSON.stringify({ type: "error", message: "Send init first" }));
				return;
			}
			console.log(`[bridge] Prompt from ${tenantId}: ${msg.text?.slice(0, 80)}`);
			runPrompt(tenantId, msg.text);
			return;
		}

		ws.send(JSON.stringify({ type: "error", message: `Unknown message type: ${msg.type}` }));
	});

	ws.on("close", () => {
		if (tenantId) {
			const tenant = tenants.get(tenantId);
			tenant?.sockets.delete(ws);
		}
	});
});

server.listen(PORT, () => {
	console.log(`Claude Code bridge listening on port ${PORT}`);
});
