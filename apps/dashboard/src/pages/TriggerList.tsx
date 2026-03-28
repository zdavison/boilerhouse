import { useState, useCallback, useEffect, useRef } from "react";
import { useApi } from "../hooks";
import { api, type TriggerSummary, type TenantMapping, type CreateTriggerInput, type TriggerTestResult, type WorkloadSummary } from "../api";
import {
	LoadingState,
	ErrorState,
	PageHeader,
	DataTable,
	DataRow,
	ActionButton,
	Modal,
} from "../components";

const TYPE_COLORS: Record<string, string> = {
	webhook: "text-status-blue bg-status-blue/10 border-status-blue/20",
	slack: "text-status-green bg-status-green/10 border-status-green/20",
	"telegram-poll": "text-accent bg-accent/10 border-accent/20",
	cron: "text-status-yellow bg-status-yellow/10 border-status-yellow/20",
};

function TypeBadge({ type }: { type: string }) {
	const cls = TYPE_COLORS[type] ?? "text-muted bg-surface-3 border-border/30";
	return (
		<span className={`px-1.5 py-0.5 text-xs font-mono rounded border ${cls}`}>
			{type}
		</span>
	);
}

function formatTenant(tenant: TenantMapping): string {
	if ("static" in tenant) return tenant.static;
	const prefix = tenant.prefix ? `${tenant.prefix}` : "";
	return `${prefix}{${tenant.fromField}}`;
}

function timeAgo(date: string | Date): string {
	const ms = Date.now() - new Date(date).getTime();
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.floor(h / 24);
	return `${d}d ago`;
}

// Sensible tenant defaults per adapter type
const TENANT_DEFAULTS: Record<string, { mode: "static" | "dynamic"; fromField: string; prefix: string }> = {
	webhook: { mode: "dynamic", fromField: "tenantId", prefix: "" },
	slack: { mode: "dynamic", fromField: "user", prefix: "slack-" },
	"telegram-poll": { mode: "dynamic", fromField: "chatId", prefix: "tg-" },
	cron: { mode: "static", fromField: "", prefix: "" },
};

// --- Create Trigger Modal ---

function CreateTriggerModal({
	onClose,
	onCreated,
}: {
	onClose: () => void;
	onCreated: () => void;
}) {
	const [name, setName] = useState("");
	const [type, setType] = useState<CreateTriggerInput["type"]>("webhook");
	const [workload, setWorkload] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// Tenant mapping fields
	const [tenantMode, setTenantMode] = useState<"static" | "dynamic">("dynamic");
	const [tenantStatic, setTenantStatic] = useState("");
	const [tenantFromField, setTenantFromField] = useState("tenantId");
	const [tenantPrefix, setTenantPrefix] = useState("");

	// Adapter-specific fields
	const [webhookPath, setWebhookPath] = useState("");
	const [webhookSecret, setWebhookSecret] = useState("");
	const [slackSigningSecret, setSlackSigningSecret] = useState("");
	const [slackBotToken, setSlackBotToken] = useState("");
	const [slackEventTypes, setSlackEventTypes] = useState("");
	const [telegramBotToken, setTelegramBotToken] = useState("");
	const [telegramUpdateTypes, setTelegramUpdateTypes] = useState("message");
	const [cronSchedule, setCronSchedule] = useState("");
	const [cronPayload, setCronPayload] = useState("");

	// Driver fields
	const [driver, setDriver] = useState("");
	const [driverOptionEntries, setDriverOptionEntries] = useState<Array<{ key: string; value: string }>>([]);

	// Load workloads for the dropdown
	const workloads = useApi<WorkloadSummary[]>(api.fetchWorkloads);

	// Known drivers and their expected option keys
	const KNOWN_DRIVERS: Record<string, { label: string; options: Array<{ key: string; placeholder: string; sensitive?: boolean }> }> = {
		"@boilerhouse/driver-openclaw": {
			label: "OpenClaw",
			options: [
				{ key: "gatewayToken", placeholder: "gateway token", sensitive: true },
			],
		},
	};

	function handleDriverChange(newDriver: string) {
		setDriver(newDriver);
		const known = KNOWN_DRIVERS[newDriver];
		if (known) {
			setDriverOptionEntries(known.options.map((o) => ({ key: o.key, value: "" })));
		} else if (newDriver === "") {
			setDriverOptionEntries([]);
		}
		// For "custom", keep existing entries
	}

	function buildDriverOptions(): Record<string, unknown> | undefined {
		if (!driver) return undefined;
		const opts: Record<string, unknown> = {};
		for (const entry of driverOptionEntries) {
			if (entry.key) opts[entry.key] = entry.value;
		}
		return Object.keys(opts).length > 0 ? opts : undefined;
	}

	// Update tenant defaults when type changes
	function handleTypeChange(newType: CreateTriggerInput["type"]) {
		setType(newType);
		const defaults = TENANT_DEFAULTS[newType]!;
		setTenantMode(defaults.mode);
		setTenantFromField(defaults.fromField);
		setTenantPrefix(defaults.prefix);
	}

	function buildTenant(): TenantMapping {
		if (tenantMode === "static") {
			return { static: tenantStatic };
		}
		const mapping: TenantMapping = { fromField: tenantFromField };
		if (tenantPrefix) (mapping as { prefix?: string }).prefix = tenantPrefix;
		return mapping;
	}

	function buildConfig(): Record<string, unknown> {
		switch (type) {
			case "webhook": {
				const cfg: Record<string, unknown> = { path: webhookPath };
				if (webhookSecret) cfg.secret = webhookSecret;
				return cfg;
			}
			case "slack":
				return {
					signingSecret: slackSigningSecret,
					botToken: slackBotToken,
					eventTypes: slackEventTypes.split(",").map((s) => s.trim()).filter(Boolean),
				};
			case "telegram-poll": {
				const cfg: Record<string, unknown> = { botToken: telegramBotToken };
				cfg.updateTypes = telegramUpdateTypes.split(",").map((s) => s.trim()).filter(Boolean);
				return cfg;
			}
			case "cron": {
				const cfg: Record<string, unknown> = { schedule: cronSchedule };
				if (cronPayload) {
					try {
						cfg.payload = JSON.parse(cronPayload);
					} catch {
						throw new Error("Invalid JSON in payload");
					}
				}
				return cfg;
			}
		}
	}

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		setSubmitting(true);

		try {
			const config = buildConfig();
			const tenant = buildTenant();
			const driverOptions = buildDriverOptions();
			await api.createTrigger({
				name, type, tenant, workload, config,
				...(driver && { driver }),
				...(driverOptions && { driverOptions }),
			});
			onCreated();
			onClose();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Failed to create trigger");
		} finally {
			setSubmitting(false);
		}
	}

	const inputCls =
		"w-full bg-surface-2 border border-border/50 rounded px-3 py-1.5 text-sm font-mono text-gray-200 focus:outline-none focus:border-accent/50";
	const labelCls = "block text-xs font-tight uppercase tracking-wider text-muted mb-1";

	return (
		<Modal title="Create Trigger" onClose={onClose}>
			<form onSubmit={handleSubmit} className="space-y-3">
				<div>
					<label className={labelCls}>Name</label>
					<input
						className={inputCls}
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="my-trigger"
						required
					/>
				</div>

				<div>
					<label className={labelCls}>Type</label>
					<select
						className={inputCls}
						value={type}
						onChange={(e) => handleTypeChange(e.target.value as CreateTriggerInput["type"])}
					>
						<option value="webhook">webhook</option>
						<option value="slack">slack</option>
						<option value="telegram-poll">telegram</option>
						<option value="cron">cron</option>
					</select>
				</div>

				<div>
					<label className={labelCls}>Workload</label>
					{workloads.data ? (
						<select
							className={inputCls}
							value={workload}
							onChange={(e) => setWorkload(e.target.value)}
							required
						>
							<option value="">select workload...</option>
							{workloads.data.map((w) => (
								<option key={w.name} value={w.name}>
									{w.name} (v{w.version})
								</option>
							))}
						</select>
					) : (
						<input
							className={inputCls}
							value={workload}
							onChange={(e) => setWorkload(e.target.value)}
							placeholder="workload-name"
							required
						/>
					)}
				</div>

				{/* Tenant mapping */}
				<fieldset className="border border-border/30 rounded px-3 py-2 space-y-2">
					<legend className={`${labelCls} px-1`}>Tenant</legend>
					<div className="flex gap-3">
						<label className="flex items-center gap-1.5 text-xs font-mono text-muted-light cursor-pointer">
							<input
								type="radio"
								name="tenantMode"
								checked={tenantMode === "static"}
								onChange={() => setTenantMode("static")}
							/>
							static
						</label>
						<label className="flex items-center gap-1.5 text-xs font-mono text-muted-light cursor-pointer">
							<input
								type="radio"
								name="tenantMode"
								checked={tenantMode === "dynamic"}
								onChange={() => setTenantMode("dynamic")}
							/>
							from event
						</label>
					</div>

					{tenantMode === "static" ? (
						<input
							className={inputCls}
							value={tenantStatic}
							onChange={(e) => setTenantStatic(e.target.value)}
							placeholder="tenant-id"
							required
						/>
					) : (
						<div className="flex gap-2">
							<div className="flex-1">
								<label className={labelCls}>Field</label>
								<input
									className={inputCls}
									value={tenantFromField}
									onChange={(e) => setTenantFromField(e.target.value)}
									placeholder="user"
									required
								/>
							</div>
							<div className="flex-1">
								<label className={labelCls}>Prefix</label>
								<input
									className={inputCls}
									value={tenantPrefix}
									onChange={(e) => setTenantPrefix(e.target.value)}
									placeholder="slack-"
								/>
							</div>
						</div>
					)}
				</fieldset>

				{/* Adapter-specific fields */}
				{type === "webhook" && (
					<>
						<div>
							<label className={labelCls}>Path</label>
							<input
								className={inputCls}
								value={webhookPath}
								onChange={(e) => setWebhookPath(e.target.value)}
								placeholder="/hooks/my-agent"
								required
							/>
						</div>
						<div>
							<label className={labelCls}>Secret (optional)</label>
							<input
								className={inputCls}
								type="password"
								value={webhookSecret}
								onChange={(e) => setWebhookSecret(e.target.value)}
								placeholder="HMAC secret"
							/>
						</div>
					</>
				)}

				{type === "slack" && (
					<>
						<div>
							<label className={labelCls}>Signing Secret</label>
							<input
								className={inputCls}
								value={slackSigningSecret}
								onChange={(e) => setSlackSigningSecret(e.target.value)}
								required
							/>
						</div>
						<div>
							<label className={labelCls}>Bot Token</label>
							<input
								className={inputCls}
								type="password"
								value={slackBotToken}
								onChange={(e) => setSlackBotToken(e.target.value)}
								placeholder="xoxb-..."
								required
							/>
						</div>
						<div>
							<label className={labelCls}>Event Types</label>
							<input
								className={inputCls}
								value={slackEventTypes}
								onChange={(e) => setSlackEventTypes(e.target.value)}
								placeholder="app_mention, message"
								required
							/>
						</div>
					</>
				)}

				{type === "telegram-poll" && (
					<>
						<div>
							<label className={labelCls}>Bot Token</label>
							<input
								className={inputCls}
								type="password"
								value={telegramBotToken}
								onChange={(e) => setTelegramBotToken(e.target.value)}
								placeholder="123456:ABC-..."
								required
							/>
						</div>
						<div>
							<label className={labelCls}>Update Types</label>
							<input
								className={inputCls}
								value={telegramUpdateTypes}
								onChange={(e) => setTelegramUpdateTypes(e.target.value)}
								placeholder="message"
							/>
						</div>
					</>
				)}

				{type === "cron" && (
					<>
						<div>
							<label className={labelCls}>Schedule</label>
							<input
								className={inputCls}
								value={cronSchedule}
								onChange={(e) => setCronSchedule(e.target.value)}
								placeholder="*/5 * * * *"
								required
							/>
						</div>
						<div>
							<label className={labelCls}>Payload (optional, JSON)</label>
							<textarea
								className={`${inputCls} h-20 resize-y`}
								value={cronPayload}
								onChange={(e) => setCronPayload(e.target.value)}
								placeholder='{ "type": "scheduled" }'
							/>
						</div>
					</>
				)}

				{/* Driver (optional) */}
				<fieldset className="border border-border/30 rounded px-3 py-2 space-y-2">
					<legend className={`${labelCls} px-1`}>Driver (optional)</legend>
					<select
						className={inputCls}
						value={Object.keys(KNOWN_DRIVERS).includes(driver) ? driver : driver ? "__custom" : ""}
						onChange={(e) => {
							const v = e.target.value;
							if (v === "__custom") {
								setDriver("");
								setDriverOptionEntries([{ key: "", value: "" }]);
							} else {
								handleDriverChange(v);
							}
						}}
					>
						<option value="">none (default)</option>
						{Object.entries(KNOWN_DRIVERS).map(([pkg, d]) => (
							<option key={pkg} value={pkg}>{d.label} ({pkg})</option>
						))}
						<option value="__custom">custom...</option>
					</select>

					{/* Custom driver package name */}
					{!Object.keys(KNOWN_DRIVERS).includes(driver) && driverOptionEntries.length > 0 && (
						<div>
							<label className={labelCls}>Package</label>
							<input
								className={inputCls}
								value={driver}
								onChange={(e) => setDriver(e.target.value)}
								placeholder="@my-org/driver-my-agent"
							/>
						</div>
					)}

					{/* Driver option fields */}
					{driverOptionEntries.length > 0 && (
						<div className="space-y-2">
							{(() => {
								const known = KNOWN_DRIVERS[driver];
								if (known) {
									// Render labeled fields for known drivers
									return known.options.map((opt, i) => (
										<div key={opt.key}>
											<label className={labelCls}>{opt.key}</label>
											<input
												className={inputCls}
												type={opt.sensitive ? "password" : "text"}
												value={driverOptionEntries[i]?.value ?? ""}
												onChange={(e) => {
													const next = [...driverOptionEntries];
													next[i] = { key: opt.key, value: e.target.value };
													setDriverOptionEntries(next);
												}}
												placeholder={opt.placeholder}
											/>
										</div>
									));
								}
								// Render key-value pairs for custom drivers
								return (
									<>
										{driverOptionEntries.map((entry, i) => (
											<div key={i} className="flex gap-2">
												<div className="flex-1">
													<input
														className={inputCls}
														value={entry.key}
														onChange={(e) => {
															const next = [...driverOptionEntries];
															next[i] = { ...entry, key: e.target.value };
															setDriverOptionEntries(next);
														}}
														placeholder="key"
													/>
												</div>
												<div className="flex-1">
													<input
														className={inputCls}
														value={entry.value}
														onChange={(e) => {
															const next = [...driverOptionEntries];
															next[i] = { ...entry, value: e.target.value };
															setDriverOptionEntries(next);
														}}
														placeholder="value"
													/>
												</div>
												<button
													type="button"
													className="text-xs font-mono text-muted hover:text-status-red transition-colors px-1"
													onClick={() => {
														setDriverOptionEntries(driverOptionEntries.filter((_, j) => j !== i));
													}}
												>
													x
												</button>
											</div>
										))}
										<button
											type="button"
											className="text-xs font-mono text-accent/70 hover:text-accent transition-colors"
											onClick={() => setDriverOptionEntries([...driverOptionEntries, { key: "", value: "" }])}
										>
											+ add option
										</button>
									</>
								);
							})()}
						</div>
					)}
				</fieldset>

				{error && <p className="text-xs font-mono text-status-red">{error}</p>}

				<div className="flex gap-2 justify-end pt-2">
					<button
						type="button"
						onClick={onClose}
						className="px-3 py-1.5 text-xs font-mono text-muted hover:text-white transition-colors"
					>
						cancel
					</button>
					<button
						type="submit"
						disabled={submitting}
						className="px-3 py-1.5 text-xs font-mono bg-accent/20 text-accent hover:bg-accent/30 rounded transition-colors disabled:opacity-50"
					>
						{submitting ? "creating..." : "create"}
					</button>
				</div>
			</form>
		</Modal>
	);
}

// --- Test Trigger Modal ---

function TestTriggerModal({
	trigger,
	onClose,
}: {
	trigger: TriggerSummary;
	onClose: () => void;
}) {
	const [tenantId, setTenantId] = useState(() => {
		if ("static" in trigger.tenant) return trigger.tenant.static;
		return trigger.tenant.prefix ? `${trigger.tenant.prefix}test-user` : "test-user";
	});
	const [payload, setPayload] = useState(() => {
		if (trigger.type === "cron") {
			const cronConfig = trigger.config as { payload?: unknown };
			return cronConfig.payload ? JSON.stringify(cronConfig.payload, null, 2) : "{}";
		}
		if (trigger.type === "slack") return JSON.stringify({ type: "app_mention", text: "hello", channel: "C0001", user: "U0001" }, null, 2);
		if (trigger.type === "telegram-poll") return JSON.stringify({ message: { text: "hello", chat: { id: 12345 }, from: { id: 67890 } } }, null, 2);
		return "{}";
	});
	const [testing, setTesting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [result, setResult] = useState<TriggerTestResult | null>(null);

	async function handleTest(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		setResult(null);
		setTesting(true);

		let parsed: unknown;
		try {
			parsed = JSON.parse(payload);
		} catch {
			setError("Invalid JSON payload");
			setTesting(false);
			return;
		}

		try {
			const res = await api.testTrigger(trigger.id, { tenantId, payload: parsed });
			setResult(res);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Test failed");
		} finally {
			setTesting(false);
		}
	}

	const inputCls =
		"w-full bg-surface-2 border border-border/50 rounded px-3 py-1.5 text-sm font-mono text-gray-200 focus:outline-none focus:border-accent/50";
	const labelCls = "block text-xs font-tight uppercase tracking-wider text-muted mb-1";

	return (
		<Modal title={`Test: ${trigger.name}`} onClose={onClose}>
			<form onSubmit={handleTest} className="space-y-3">
				<div>
					<label className={labelCls}>Tenant ID</label>
					<input
						className={inputCls}
						value={tenantId}
						onChange={(e) => setTenantId(e.target.value)}
						placeholder="test-tenant"
						required
					/>
					{"fromField" in trigger.tenant && (
						<p className="text-xs text-muted mt-1">
							Normally resolved from <span className="font-mono text-muted-light">{trigger.tenant.prefix ?? ""}{`{${trigger.tenant.fromField}}`}</span>
						</p>
					)}
				</div>

				<div>
					<label className={labelCls}>Payload (JSON)</label>
					<textarea
						className={`${inputCls} h-32 resize-y`}
						value={payload}
						onChange={(e) => setPayload(e.target.value)}
						placeholder="{}"
					/>
				</div>

				{testing && (
					<div className="flex items-center gap-2 text-xs font-mono text-muted py-2">
						<span className="animate-pulse">claiming tenant and forwarding payload...</span>
					</div>
				)}

				{error && <p className="text-xs font-mono text-status-red">{error}</p>}

				{result && (
					<div className="border border-border/30 rounded p-3 space-y-2 bg-surface-1">
						<div className="flex gap-4 text-xs font-mono">
							<span className="text-muted">source: <span className="text-muted-light">{result.claim.source}</span></span>
							<span className="text-muted">latency: <span className="text-muted-light">{result.claim.latencyMs}ms</span></span>
							<span className="text-muted">instance: <span className="text-muted-light">{result.claim.instanceId.slice(0, 8)}</span></span>
						</div>
						{result.error && (
							<p className="text-xs font-mono text-status-yellow">{result.error}</p>
						)}
						{result.response && (
							<div>
								<p className="text-xs font-mono text-muted mb-1">
									response <span className={result.response.status >= 400 ? "text-status-red" : "text-status-green"}>
										{result.response.status}
									</span>
								</p>
								<pre className="text-xs font-mono text-gray-300 bg-surface-2 rounded p-2 overflow-auto max-h-48">
									{typeof result.response.body === "string"
										? result.response.body
										: JSON.stringify(result.response.body, null, 2)}
								</pre>
							</div>
						)}
					</div>
				)}

				<div className="flex gap-2 justify-end pt-2">
					<button
						type="button"
						onClick={onClose}
						className="px-3 py-1.5 text-xs font-mono text-muted hover:text-white transition-colors"
					>
						close
					</button>
					<button
						type="submit"
						disabled={testing}
						className="px-3 py-1.5 text-xs font-mono bg-accent/20 text-accent hover:bg-accent/30 rounded transition-colors disabled:opacity-50"
					>
						{testing ? "testing..." : "send"}
					</button>
				</div>
			</form>
		</Modal>
	);
}

// --- Trigger List ---

export function TriggerList({ tick }: { tick?: number }) {
	const { data, loading, error, refetch } = useApi<TriggerSummary[]>(api.fetchTriggers);

	const [showCreate, setShowCreate] = useState(false);
	const [testingTrigger, setTestingTrigger] = useState<TriggerSummary | null>(null);

	// Refetch when tick changes (WS events) without remounting.
	// Skip refetch while the test modal is open to avoid flashing loading state.
	const initialTick = useRef(tick);
	useEffect(() => {
		if (tick !== initialTick.current && !testingTrigger) refetch();
	}, [tick, refetch, testingTrigger]);

	const handleToggle = useCallback(
		async (trigger: TriggerSummary) => {
			try {
				if (trigger.enabled) {
					await api.disableTrigger(trigger.id);
				} else {
					await api.enableTrigger(trigger.id);
				}
				refetch();
			} catch (err) {
				console.error("Failed to toggle trigger:", err);
			}
		},
		[refetch],
	);

	const handleDelete = useCallback(
		async (trigger: TriggerSummary) => {
			if (!confirm(`Delete trigger "${trigger.name}"?`)) return;
			try {
				await api.deleteTrigger(trigger.id);
				refetch();
			} catch (err) {
				console.error("Failed to delete trigger:", err);
			}
		},
		[refetch],
	);

	if (loading && !data) return <LoadingState />;
	if (error && !data) return <ErrorState message={error} />;
	if (!data) return null;

	return (
		<div>
			<div className="flex items-center justify-between mb-6">
				<PageHeader>triggers</PageHeader>
				<ActionButton
					label="create trigger"
					variant="info"
					onClick={() => setShowCreate(true)}
				/>
			</div>

			{data.length === 0 ? (
				<p className="text-muted font-mono text-sm">no triggers configured.</p>
			) : (
				<DataTable headers={["Name", "Type", "Workload", "Tenant", "Driver", "Status", "Last Invoked", "Actions"]}>
					{data.map((t) => (
						<DataRow key={t.id}>
							<td className="px-4 py-3 text-gray-200">{t.name}</td>
							<td className="px-4 py-3">
								<TypeBadge type={t.type} />
							</td>
							<td className="px-4 py-3 text-muted-light">{t.workload}</td>
							<td className="px-4 py-3 text-muted-light font-mono text-xs">
								{formatTenant(t.tenant)}
							</td>
							<td className="px-4 py-3 text-muted font-mono text-xs">
								{t.driver
									? t.driver.replace(/^@boilerhouse\/driver-/, "")
									: <span className="text-muted/50">default</span>}
							</td>
							<td className="px-4 py-3">
								<span
									className={`font-mono text-sm ${t.enabled ? "text-status-green" : "text-muted"}`}
									title={t.enabled ? "enabled" : "disabled"}
								>
									{t.enabled ? "\u25CF" : "\u25CB"}
								</span>
							</td>
							<td className="px-4 py-3 text-muted text-xs">
								{t.lastInvokedAt ? timeAgo(t.lastInvokedAt) : "never"}
							</td>
							<td className="px-4 py-3">
								<div className="flex gap-2">
									<ActionButton
										label="test"
										variant="info"
										onClick={() => setTestingTrigger(t)}
									/>
									<ActionButton
										label={t.enabled ? "disable" : "enable"}
										variant="warning"
										onClick={() => handleToggle(t)}
									/>
									<ActionButton
										label="delete"
										variant="danger"
										onClick={() => handleDelete(t)}
									/>
								</div>
							</td>
						</DataRow>
					))}
				</DataTable>
			)}

			{showCreate && (
				<CreateTriggerModal
					onClose={() => setShowCreate(false)}
					onCreated={refetch}
				/>
			)}

			{testingTrigger && (
				<TestTriggerModal
					trigger={testingTrigger}
					onClose={() => setTestingTrigger(null)}
				/>
			)}
		</div>
	);
}
