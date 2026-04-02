/**
 * E2E: Telegram poll → OpenClaw container → response back to Telegram.
 *
 * Mocks: Telegram API, Anthropic LLM API
 * Real: Boilerhouse (docker), OpenClaw container
 *
 * Run: bun test tests/e2e/telegram-poll.e2e.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { resolve } from "node:path";
import { resolveWorkloadConfig } from "@boilerhouse/core";
import {
	TelegramPollAdapter,
	Dispatcher,
	SessionManager,
	resolveDriver,
} from "@boilerhouse/triggers";
import type { DriverMap, TriggerDefinition, TelegramPollConfig } from "@boilerhouse/triggers";
import { startE2EServer, api, waitForWorkloadReady, type E2EServer } from "./e2e-helpers";

// ── Mock Telegram API ────────────────────────────────────────────────────────

interface CapturedReply {
	chat_id: number;
	text: string;
}

function createMockTelegram() {
	const replies: CapturedReply[] = [];
	let pendingUpdates: Array<Record<string, unknown>> = [];
	let updateIdSeq = 1;
	let replyWaiter: ((reply: CapturedReply) => void) | null = null;

	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			const path = new URL(req.url).pathname.replace(/^\/bot[^/]+/, "");

			if (path === "/getMe") {
				return Response.json({
					ok: true,
					result: { id: 999, is_bot: true, first_name: "E2EBot", username: "e2e_test_bot" },
				});
			}
			if (path === "/deleteWebhook") {
				return Response.json({ ok: true });
			}
			if (path === "/getUpdates") {
				if (pendingUpdates.length === 0) {
					await new Promise((r) => setTimeout(r, 200));
					return Response.json({ ok: true, result: [] });
				}
				const batch = pendingUpdates;
				pendingUpdates = [];
				return Response.json({ ok: true, result: batch });
			}
			if (path === "/sendMessage") {
				const body = await req.json() as CapturedReply;
				replies.push(body);
				if (replyWaiter) {
					replyWaiter(body);
					replyWaiter = null;
				}
				return Response.json({ ok: true, result: { message_id: Date.now() } });
			}
			return Response.json({ ok: false, description: `Unknown: ${path}` }, { status: 404 });
		},
	});

	return {
		url: `http://localhost:${server.port}`,
		stageMessage(chatId: number, userId: number, text: string) {
			pendingUpdates.push({
				update_id: updateIdSeq++,
				message: {
					message_id: updateIdSeq,
					from: { id: userId, is_bot: false, first_name: "Tester" },
					chat: { id: chatId, type: "private" },
					date: Math.floor(Date.now() / 1000),
					text,
				},
			});
		},
		replies,
		waitForReply(timeoutMs = 120_000): Promise<CapturedReply> {
			if (replies.length > 0) return Promise.resolve(replies[replies.length - 1]!);
			return new Promise((resolve, reject) => {
				const timer = setTimeout(() => {
					replyWaiter = null;
					reject(new Error(`No reply within ${timeoutMs}ms`));
				}, timeoutMs);
				replyWaiter = (reply) => { clearTimeout(timer); resolve(reply); };
			});
		},
		stop() { server.stop(true); },
	};
}

// ── Mock Anthropic API ───────────────────────────────────────────────────────

function createMockLLM() {
	let requestCount = 0;
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			console.log(`[mock-llm] ${req.method} ${url.pathname} (#${++requestCount})`);
			if (url.pathname === "/v1/messages" && req.method === "POST") {
				const body = await req.json() as {
					stream?: boolean;
					messages?: Array<{ role: string; content: string | Array<{ type: string; text: string }> }>;
				};

				const lastUserMsg = body.messages
					?.filter((m) => m.role === "user")
					.pop();
				const userText = typeof lastUserMsg?.content === "string"
					? lastUserMsg.content
					: Array.isArray(lastUserMsg?.content)
						? lastUserMsg.content.find((c) => c.type === "text")?.text ?? ""
						: "";

				const replyText = `Mock reply to: ${userText}`;

				if (body.stream) {
					// Anthropic SSE streaming format
					const events = [
						`event: message_start\ndata: ${JSON.stringify({
							type: "message_start",
							message: {
								id: "msg_mock",
								type: "message",
								role: "assistant",
								content: [],
								model: "claude-sonnet-4-20250514",
								stop_reason: null,
								usage: { input_tokens: 10, output_tokens: 0 },
							},
						})}\n`,
						`event: content_block_start\ndata: ${JSON.stringify({
							type: "content_block_start",
							index: 0,
							content_block: { type: "text", text: "" },
						})}\n`,
						`event: content_block_delta\ndata: ${JSON.stringify({
							type: "content_block_delta",
							index: 0,
							delta: { type: "text_delta", text: replyText },
						})}\n`,
						`event: content_block_stop\ndata: ${JSON.stringify({
							type: "content_block_stop",
							index: 0,
						})}\n`,
						`event: message_delta\ndata: ${JSON.stringify({
							type: "message_delta",
							delta: { stop_reason: "end_turn" },
							usage: { output_tokens: 10 },
						})}\n`,
						`event: message_stop\ndata: ${JSON.stringify({
							type: "message_stop",
						})}\n`,
					];

					return new Response(
						new ReadableStream({
							async start(controller) {
								for (const event of events) {
									controller.enqueue(new TextEncoder().encode(event + "\n"));
									await new Promise((r) => setTimeout(r, 10));
								}
								controller.close();
							},
						}),
						{
							headers: { "Content-Type": "text/event-stream" },
						},
					);
				}

				// Non-streaming response
				return Response.json({
					id: "msg_mock",
					type: "message",
					role: "assistant",
					content: [{ type: "text", text: replyText }],
					model: "claude-sonnet-4-20250514",
					stop_reason: "end_turn",
					usage: { input_tokens: 10, output_tokens: 10 },
				});
			}
			return Response.json({ error: "not found" }, { status: 404 });
		},
	});
	return {
		url: `http://localhost:${server.port}`,
		stop() { server.stop(true); },
	};
}

// ── Test ──────────────────────────────────────────────────────────────────────

const GATEWAY_TOKEN = "73307c8aab2b025f959a53f5095c0addec0be76fe4b5d470";

describe("telegram-poll → openclaw E2E", () => {
	let server: E2EServer;
	let mockTG: ReturnType<typeof createMockTelegram>;
	let mockLLM: ReturnType<typeof createMockLLM>;
	let pollAdapter: TelegramPollAdapter;

	beforeAll(async () => {
		mockTG = createMockTelegram();
		mockLLM = createMockLLM();

		server = await startE2EServer("docker");

		// Register openclaw workload — override LLM URL to mock.
		// We build the config from scratch rather than cloning the fixture
		// because the fixture uses SecretRef which can't be structuredClone'd.
		const workloadsDir = resolve(import.meta.dir, "../../workloads");
		const workload = resolveWorkloadConfig({
			name: "openclaw",
			version: "2026.3.24",
			image: { dockerfile: resolve(workloadsDir, "openclaw/Dockerfile") },
			resources: { vcpus: 2, memory_mb: 2048, disk_gb: 10 },
			network: {
				access: "unrestricted",
				expose: [{ guest: 18789, host_range: [30000, 30099] }],
				websocket: "/",
				credentials: [{
					domain: "api.anthropic.com",
					headers: { "x-api-key": "sk-ant-mock-key" },
				}],
			},
			filesystem: { overlay_dirs: ["/home/node/.openclaw"] },
			idle: { timeout_seconds: 600, action: "hibernate" },
			health: {
				interval_seconds: 2,
				unhealthy_threshold: 30,
				http_get: { path: "/__openclaw/control-ui-config.json", port: 18789 },
			},
			entrypoint: {
				workdir: "/app",
				cmd: "/bin/sh",
				args: [
					"-c",
					'mkdir -p /home/node/.openclaw && echo \'{"gateway":{"controlUi":{"dangerouslyAllowHostHeaderOriginFallback":true},"http":{"endpoints":{"chatCompletions":{"enabled":true}}}}}\' > /home/node/.openclaw/openclaw.json && exec docker-entrypoint.sh node openclaw.mjs gateway --allow-unconfigured --bind lan',
				],
				env: {
					OPENCLAW_GATEWAY_TOKEN: GATEWAY_TOKEN,
					OPENCLAW_CONFIG_PATH: "/home/node/.openclaw/openclaw.json",
					// Use host.docker.internal so the container can reach the mock on the host
				ANTHROPIC_BASE_URL: mockLLM.url.replace("localhost", "host.docker.internal"),
					ANTHROPIC_API_KEY: "sk-ant-mock-key",
				},
			},
		});
		const wlRes = await api(server, "POST", "/api/v1/workloads", workload);
		expect(wlRes.status).toBe(201);
		console.log("[e2e] Workload registered");

		await waitForWorkloadReady(server, "openclaw", 90_000);
		console.log("[e2e] Workload ready");

		// Resolve the openclaw driver
		const resolved = await resolveDriver(
			"@boilerhouse/driver-openclaw",
			{ gatewayToken: GATEWAY_TOKEN },
		);
		const driverMap: DriverMap = new Map();
		driverMap.set("e2e-tg", {
			driver: resolved.driver,
			driverConfig: { options: resolved.options },
		});

		// Build a dispatcher that claims via the API
		const sessionManager = new SessionManager();
		const dispatcher = new Dispatcher(
			{
				async claim(tenantId: string, workloadName: string) {
					const res = await api(server, "POST", `/api/v1/tenants/${tenantId}/claim`, {
						workload: workloadName,
					});
					if (!res.ok) {
						const body = await res.text();
						throw new Error(`Claim failed (${res.status}): ${body}`);
					}
					return await res.json() as any;
				},
				logActivity() {},
			},
			{ sessionManager },
		);

		// Start the poll adapter pointing at mock Telegram
		const trigger: TriggerDefinition & { config: TelegramPollConfig } = {
			name: "e2e-tg",
			type: "telegram-poll",
			workload: "openclaw",
			tenant: { fromField: "chatId", prefix: "tg-" },
			config: {
				botToken: "123456:FAKE",
				updateTypes: ["message"],
				pollTimeoutSeconds: 1,
				apiBaseUrl: mockTG.url,
			},
			driver: "@boilerhouse/driver-openclaw",
			driverOptions: { gatewayToken: GATEWAY_TOKEN },
		};

		pollAdapter = new TelegramPollAdapter();
		pollAdapter.start([trigger], dispatcher, driverMap);
		console.log("[e2e] Poll adapter started");
	}, 120_000);

	afterAll(async () => {
		pollAdapter?.stop();
		if (server) await server.cleanup();
		mockTG?.stop();
		mockLLM?.stop();
	});

	test("user message → openclaw → reply in mock Telegram", async () => {
		// Stage a message from a user
		mockTG.stageMessage(42001, 77001, "What is 2+2?");
		console.log("[e2e] Staged message, waiting for reply...");

		// Wait for openclaw to process and reply
		const reply = await mockTG.waitForReply(120_000);

		expect(reply.chat_id).toBe(42001);
		expect(reply.text.length).toBeGreaterThan(0);
		console.log(`[e2e] Got reply (${reply.text.length} chars): "${reply.text.slice(0, 100)}..."`);
	}, 180_000);
});
