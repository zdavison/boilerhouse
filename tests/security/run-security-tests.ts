/**
 * Security test runner — boots the API server with pre-seeded triggers,
 * runs Nuclei templates against it, and reports findings.
 *
 * Usage: bunx kadai run security
 */
import { randomBytes, createHmac } from "node:crypto";
import {
	FakeRuntime,
	generateNodeId,
	generateTriggerId,
} from "../../packages/core/src/index";
import type { Runtime, TriggerId } from "../../packages/core/src/index";
import { createTestDatabase, ActivityLog, nodes, triggers } from "../../packages/db/src/index";
import type { DrizzleDb } from "../../packages/db/src/index";
import { createLogger } from "../../packages/o11y/src/index";
import { InstanceManager } from "../../apps/api/src/instance-manager";
import { SnapshotManager } from "../../apps/api/src/snapshot-manager";
import { TenantManager } from "../../apps/api/src/tenant-manager";
import { TenantDataStore } from "../../apps/api/src/tenant-data";
import { EventBus } from "../../apps/api/src/event-bus";
import { GoldenCreator } from "../../apps/api/src/golden-creator";
import { BootstrapLogStore } from "../../apps/api/src/bootstrap-log-store";
import { ResourceLimiter } from "../../apps/api/src/resource-limits";
import { SecretStore } from "../../apps/api/src/secret-store";
import { createApp } from "../../apps/api/src/app";
import {
	Dispatcher,
	SessionManager,
	createWebhookRoutes,
	createSlackRoutes,
	createTelegramRoutes,
} from "../../packages/triggers/src/index";
import type {
	DispatcherDeps,
	TriggerDefinition,
	WebhookConfig,
	SlackConfig,
	TelegramConfig,
} from "../../packages/triggers/src/index";
// Re-use Elysia from a workspace package that already depends on it
const { Elysia } = await import("../../apps/api/node_modules/elysia");

// ── Config ──────────────────────────────────────────────────────────────────

const TENANT_A = "sec-tenant-a";
const TENANT_B = "sec-tenant-b";
const SECRET_VALUE = "hunter2-sec-test-value";
const WORKLOAD_NAME = "sec-test-minimal";
const WEBHOOK_TRIGGER_NAME = "sec-test-webhook";
const WEBHOOK_SECRET = "test-webhook-secret-key";
const SLACK_SIGNING_SECRET = "test-slack-signing-secret";
const TELEGRAM_TRIGGER_NAME = "sec-test-telegram";
const TELEGRAM_SECRET_TOKEN = "test-telegram-secret-token";

// ── Server bootstrap (like startE2EServer but with trigger pre-seeding) ─────

async function startSecurityServer() {
	const db = createTestDatabase();
	const nodeId = generateNodeId();
	const activityLog = new ActivityLog(db);
	const eventBus = new EventBus();

	// Insert a node so FK constraints pass
	db.insert(nodes)
		.values({
			nodeId,
			runtimeType: "podman",
			capacity: { vcpus: 8, memoryMb: 16384, diskGb: 100 },
			status: "online",
			lastHeartbeat: new Date(),
			createdAt: new Date(),
		})
		.run();

	// Pre-seed trigger definitions so adapter routes are mounted at startup
	seedTriggers(db);

	const secretKey = randomBytes(32).toString("hex");
	const secretStore = new SecretStore(db, secretKey);

	const fakeFailOn = new Set<string>();
	const runtime: Runtime = new FakeRuntime({ failOn: fakeFailOn });

	const log = createLogger("security");
	const instanceManager = new InstanceManager(
		runtime,
		db,
		activityLog,
		nodeId,
		eventBus,
		log,
		secretStore,
	);
	const snapshotManager = new SnapshotManager(runtime, db, nodeId, {
		healthChecker: async () => {},
		secretStore,
	});
	const tenantDataStore = new TenantDataStore("/tmp/boilerhouse-sec", db);
	const tenantManager = new TenantManager(
		instanceManager,
		snapshotManager,
		db,
		activityLog,
		nodeId,
		tenantDataStore,
		undefined,
		log,
		eventBus,
	);

	const resourceLimiter = new ResourceLimiter(db, { maxInstances: 100 });
	const bootstrapLogStore = new BootstrapLogStore(db);
	const goldenCreator = new GoldenCreator(db, snapshotManager, eventBus, bootstrapLogStore);

	const app = createApp({
		db,
		runtime,
		nodeId,
		activityLog,
		instanceManager,
		tenantManager,
		snapshotManager,
		eventBus,
		goldenCreator,
		bootstrapLogStore,
		resourceLimiter,
		secretStore,
		log,
	});

	const server = app.listen(0);
	const port = server.server!.port;
	const baseUrl = `http://localhost:${port}`;

	// Start a standalone trigger gateway that proxies claims to the API via HTTP
	const triggerGateway = startTriggerGateway(baseUrl, db);
	const triggerServer = triggerGateway.listen(0);
	const triggerPort = triggerServer.server!.port;
	const triggerBaseUrl = `http://localhost:${triggerPort}`;

	return {
		baseUrl,
		triggerBaseUrl,
		db,
		secretStore,
		cleanup: async () => {
			server.stop();
			triggerServer.stop();
			resourceLimiter.dispose();
		},
	};
}

function seedTriggers(db: DrizzleDb) {
	const now = new Date();

	// Webhook trigger with HMAC secret
	db.insert(triggers)
		.values({
			id: generateTriggerId(),
			name: WEBHOOK_TRIGGER_NAME,
			type: "webhook",
			tenant: { fromField: "body.tenant_id" },
			workload: WORKLOAD_NAME,
			config: {
				path: `/hooks/${WEBHOOK_TRIGGER_NAME}`,
				secret: WEBHOOK_SECRET,
			},
			enabled: 1,
			createdAt: now,
			updatedAt: now,
		})
		.run();

	// Slack trigger with signing secret
	db.insert(triggers)
		.values({
			id: generateTriggerId(),
			name: "sec-test-slack",
			type: "slack",
			tenant: { fromField: "user", prefix: "slack-" },
			workload: WORKLOAD_NAME,
			config: {
				signingSecret: SLACK_SIGNING_SECRET,
				eventTypes: ["app_mention", "message"],
				botToken: "xoxb-fake-bot-token",
			},
			enabled: 1,
			createdAt: now,
			updatedAt: now,
		})
		.run();

	// Telegram trigger with secret token
	db.insert(triggers)
		.values({
			id: generateTriggerId(),
			name: TELEGRAM_TRIGGER_NAME,
			type: "telegram",
			tenant: { fromField: "chatId", prefix: "tg-" },
			workload: WORKLOAD_NAME,
			config: {
				botToken: "123456:FAKE-BOT-TOKEN",
				secretToken: TELEGRAM_SECRET_TOKEN,
				updateTypes: ["message"],
			},
			enabled: 1,
			createdAt: now,
			updatedAt: now,
		})
		.run();
}

// ── Trigger gateway (separate process simulation) ───────────────────────────

function startTriggerGateway(apiBaseUrl: string, db: DrizzleDb) {
	// Load trigger definitions from DB (same as production gateway reads from config)
	const rows = db
		.select()
		.from(triggers)
		.all();

	const allTriggers: TriggerDefinition[] = rows.map((row) => ({
		name: row.name,
		type: row.type as TriggerDefinition["type"],
		tenant: row.tenant as TriggerDefinition["tenant"],
		workload: row.workload,
		config: row.config as unknown as TriggerDefinition["config"],
	}));

	// Dispatcher deps: proxy claims to internal API via HTTP
	const dispatcherDeps: DispatcherDeps = {
		async claim(tenantId: string, workloadName: string) {
			const res = await fetch(
				`${apiBaseUrl}/api/v1/tenants/${encodeURIComponent(tenantId)}/claim`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ workload: workloadName }),
				},
			);
			if (!res.ok) {
				const body = await res.json().catch(() => ({ error: "Unknown error" }));
				throw new Error(
					`Claim failed (${res.status}): ${(body as Record<string, string>).error ?? JSON.stringify(body)}`,
				);
			}
			return res.json();
		},
		logActivity() {},
	};

	const sessionManager = new SessionManager();
	const dispatcher = new Dispatcher(dispatcherDeps, { sessionManager });

	const webhookTriggers = allTriggers.filter(
		(t): t is TriggerDefinition & { config: WebhookConfig } => t.type === "webhook",
	);
	const slackTriggers = allTriggers.filter(
		(t): t is TriggerDefinition & { config: SlackConfig } => t.type === "slack",
	);
	const telegramTriggers = allTriggers.filter(
		(t): t is TriggerDefinition & { config: TelegramConfig } => t.type === "telegram",
	);

	const webhookRoutes = createWebhookRoutes(webhookTriggers, dispatcher);
	const slackRoutes = createSlackRoutes(slackTriggers, dispatcher);
	const telegramRoutes = createTelegramRoutes(telegramTriggers, dispatcher);

	const triggerApp = new Elysia()
		.get("/healthz", () => ({ status: "ok" }));

	const allRoutes = { ...webhookRoutes, ...slackRoutes, ...telegramRoutes };
	for (const [path, handler] of Object.entries(allRoutes)) {
		triggerApp.post(path, async ({ request }) => handler(request));
	}

	return triggerApp;
}

// ── Compute HMAC signatures for replay tests ───────────────────────────────

function computeSlackSignature(
	signingSecret: string,
	timestamp: string,
	body: string,
): string {
	const baseString = `v0:${timestamp}:${body}`;
	const hmac = createHmac("sha256", signingSecret);
	hmac.update(baseString);
	return `v0=${hmac.digest("hex")}`;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
	console.log("Starting security test server...");
	const server = await startSecurityServer();
	console.log(`API server running at ${server.baseUrl}`);
	console.log(`Trigger server running at ${server.triggerBaseUrl}`);

	try {
		// Compute valid Slack replay signature for the replay test
		const slackReplayTimestamp = "1000000000";
		const slackReplayBody = JSON.stringify({
			type: "event_callback",
			team_id: "T12345",
			event: {
				type: "app_mention",
				user: "U12345",
				channel: "C12345",
				text: "replay test",
			},
		});
		const slackReplaySig = computeSlackSignature(
			SLACK_SIGNING_SECRET,
			slackReplayTimestamp,
			slackReplayBody,
		);

		// Check nuclei is installed — offer to install if missing
		const whichNuclei = Bun.spawnSync(["which", "nuclei"], { stdout: "pipe" });
		if (whichNuclei.exitCode !== 0) {
			console.log("nuclei is not installed.");
			const rl = await import("node:readline");
			const iface = rl.createInterface({ input: process.stdin, output: process.stdout });
			const answer = await new Promise<string>((resolve) =>
				iface.question("Install via brew? [Y/n] ", resolve),
			);
			iface.close();
			if (answer.trim().toLowerCase() !== "n") {
				const install = Bun.spawnSync(["brew", "install", "nuclei"], {
					stdout: "inherit",
					stderr: "inherit",
				});
				if (install.exitCode !== 0) {
					console.error("Failed to install nuclei.");
					process.exit(1);
				}
			} else {
				console.error("Aborted. Install manually with: brew install nuclei");
				process.exit(1);
			}
		}

		console.log("Running nuclei templates...");
		const proc = Bun.spawn(
			[
				"nuclei",
				"-t", "tests/security/nuclei-templates/",
				"-target", server.baseUrl,
				"-j",
				"-irr",
				"-rl", "50",
				"-timeout", "10",
				"-nc",
				"-stats",
				"-duc",            // disable update check
				"-V", `tenant_a_id=${TENANT_A}`,
				"-V", `tenant_b_id=${TENANT_B}`,
				"-V", `secret_value=${SECRET_VALUE}`,
				"-V", `workload_name=${WORKLOAD_NAME}`,
				"-V", `trigger_base_url=${server.triggerBaseUrl}`,
				"-V", `webhook_trigger_name=${WEBHOOK_TRIGGER_NAME}`,
				"-V", `telegram_trigger_name=${TELEGRAM_TRIGGER_NAME}`,
				"-V", `slack_replay_signature=${slackReplaySig}`,
				"-V", `slack_replay_body=${slackReplayBody}`,
			],
			{
				stdout: "pipe",
				stderr: "inherit",
				cwd: import.meta.dir + "/../..",
			},
		);

		const output = await new Response(proc.stdout).text();
		const exitCode = await proc.exited;

		// Parse JSON findings (one per line)
		const findings = output
			.trim()
			.split("\n")
			.filter((line) => line.startsWith("{"))
			.map((line) => {
				try {
					return JSON.parse(line);
				} catch {
					return null;
				}
			})
			.filter(Boolean);

		if (findings.length > 0) {
			console.error(`\n\u274C ${findings.length} security finding(s):\n`);
			for (const f of findings) {
				const severity = f.info?.severity ?? "unknown";
				const name = f.info?.name ?? f["template-id"] ?? "unnamed";
				const matchedAt = f["matched-at"] ?? "";
				console.error(`  [${severity}] ${name} \u2014 ${matchedAt}`);
			}
			process.exit(1);
		}

		// Also check nuclei's own exit code for errors
		if (exitCode !== 0 && findings.length === 0) {
			console.error(`\nNuclei exited with code ${exitCode} but reported no findings.`);
			console.error("This may indicate a template parsing error. Check stderr above.");
			process.exit(1);
		}

		console.log("\n\u2705 No security findings.");
	} finally {
		await server.cleanup();
	}
}

main().catch((err) => {
	console.error("Security test runner failed:", err);
	process.exit(1);
});
