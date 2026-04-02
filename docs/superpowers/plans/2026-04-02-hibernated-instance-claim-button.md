# Hibernated Instance Claim Button Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `UserPlus` claim button to hibernated instance rows in the dashboard so operators can reclaim a hibernated tenant's instance in one click.

**Architecture:** Single-file change in `WorkloadList.tsx`. Thread a new `onClaimInstance` callback from `WorkloadList` → `WorkloadGroup` → `InstanceSection` → `InstanceRow`. The button only renders when `status === "hibernated" && tenantId !== null` and calls `api.claimWorkload(tenantId, workloadName)` with the same busy-state pattern used by other instance actions.

**Tech Stack:** React, TypeScript, Bun (test runner), existing `api.claimWorkload` and `IconButton`/`UserPlus` already in scope.

---

### Task 1: Add `onClaimInstance` prop to `InstanceRow` and render the button

**Files:**
- Modify: `apps/dashboard/src/pages/WorkloadList.tsx:215-285`

No dashboard component tests exist (only `prometheus.test.ts`). Verify manually: run the dev server and confirm the button appears on hibernated+tenant rows.

- [ ] **Step 1: Add `onClaimInstance` to `InstanceRow` props and render the button**

In `WorkloadList.tsx`, update the `InstanceRow` function signature and its actions block:

```tsx
function InstanceRow({
	instance,
	onAction,
	onConnect,
	onClaimInstance,
	workloadName,
	busy,
	idleTimeoutSeconds,
}: {
	instance: InstanceSummary;
	onAction: (id: string, action: "destroy" | "hibernate") => void;
	onConnect: (id: string, workloadName: string) => void;
	onClaimInstance?: (instanceId: string, tenantId: string, workloadName: string) => void;
	workloadName: string;
	/** When true, action buttons are replaced with a spinner. */
	busy?: boolean;
	idleTimeoutSeconds?: number | null;
}) {
```

Then update the actions `<div>` inside `InstanceRow` (the block that currently contains the `active+tenantId` buttons and the Destroy button):

```tsx
<div className="flex items-center gap-0.5">
	{instance.status === "active" && instance.tenantId !== null && (
		<>
			<IconButton icon={Plug} title="Connect" variant="info" onClick={() => onConnect(instance.instanceId, workloadName)} />
			<IconButton icon={Moon} title="Hibernate" variant="warning" onClick={() => onAction(instance.instanceId, "hibernate")} />
		</>
	)}
	{instance.status === "hibernated" && instance.tenantId !== null && (
		<IconButton
			icon={UserPlus}
			title="Claim"
			variant="info"
			onClick={() => onClaimInstance?.(instance.instanceId, instance.tenantId!, workloadName)}
		/>
	)}
	<IconButton icon={Trash2} title="Destroy" variant="danger" onClick={() => onAction(instance.instanceId, "destroy")} />
</div>
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd apps/dashboard && bunx tsc --noEmit
```

Expected: no errors.

---

### Task 2: Thread `onClaimInstance` through `InstanceSection` and `WorkloadGroup`

**Files:**
- Modify: `apps/dashboard/src/pages/WorkloadList.tsx:289-418`

- [ ] **Step 1: Add `onClaimInstance` to `InstanceSection`**

Update `InstanceSection` props interface and its `InstanceRow` usage:

```tsx
function InstanceSection({
	label,
	instances,
	onAction,
	onConnect,
	onClaimInstance,
	workloadName,
	busyInstances,
	idleTimeoutSeconds,
}: {
	label: string;
	instances: InstanceNode[];
	onAction: (id: string, action: "destroy" | "hibernate") => void;
	onConnect: (id: string, workloadName: string) => void;
	onClaimInstance?: (instanceId: string, tenantId: string, workloadName: string) => void;
	workloadName: string;
	busyInstances: Set<string>;
	idleTimeoutSeconds?: number | null;
}) {
	return (
		<>
			<div
				className="flex items-center h-6 px-2 border-b border-border/10"
				style={{ paddingLeft: GUTTER_W + STATUS_W + 8 }}
			>
				<span className="text-xs text-muted font-mono uppercase tracking-wider">{label}</span>
				<span className="text-xs text-muted font-mono ml-1.5">({instances.length})</span>
			</div>
			{instances.map((inst) => (
				<InstanceRow
					key={inst.instance.instanceId}
					instance={inst.instance}
					onAction={onAction}
					onConnect={onConnect}
					onClaimInstance={onClaimInstance}
					workloadName={workloadName}
					busy={busyInstances.has(inst.instance.instanceId)}
					idleTimeoutSeconds={idleTimeoutSeconds}
				/>
			))}
		</>
	);
}
```

- [ ] **Step 2: Add `onClaimInstance` to `WorkloadGroup`**

Update `WorkloadGroup` props interface and both `InstanceSection` usages inside it:

```tsx
function WorkloadGroup({
	node,
	expanded,
	onToggle,
	onAction,
	onConnect,
	onClaimInstance,
	navigate,
	busyInstances,
	onClaim,
}: {
	node: WorkloadTreeNode;
	expanded: boolean;
	onToggle: () => void;
	onAction: (id: string, action: "destroy" | "hibernate") => void;
	onConnect: (id: string, workloadName: string) => void;
	onClaimInstance?: (instanceId: string, tenantId: string, workloadName: string) => void;
	navigate: (path: string) => void;
	busyInstances: Set<string>;
	onClaim?: () => void;
}) {
```

And update both `InstanceSection` usages inside `WorkloadGroup` (pool and claimed) to pass `onClaimInstance`:

```tsx
{poolInstances.length > 0 && (
	<InstanceSection
		label="pool"
		instances={poolInstances}
		onAction={onAction}
		onConnect={onConnect}
		onClaimInstance={onClaimInstance}
		workloadName={workload.name}
		busyInstances={busyInstances}
	/>
)}
{claimedInstances.length > 0 && (
	<InstanceSection
		label="claimed"
		instances={claimedInstances}
		onAction={onAction}
		onConnect={onConnect}
		onClaimInstance={onClaimInstance}
		workloadName={workload.name}
		busyInstances={busyInstances}
		idleTimeoutSeconds={workload.idleTimeoutSeconds}
	/>
)}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd apps/dashboard && bunx tsc --noEmit
```

Expected: no errors.

---

### Task 3: Implement `handleClaim` in `WorkloadList` and wire up `WorkloadGroup`

**Files:**
- Modify: `apps/dashboard/src/pages/WorkloadList.tsx:422-535`

- [ ] **Step 1: Add `handleClaim` function in `WorkloadList`**

Add this function after `handleAction` (around line 501):

```tsx
async function handleClaim(instanceId: string, tenantId: string, workloadName: string) {
	setBusyInstances((prev) => new Set(prev).add(instanceId));
	try {
		await api.claimWorkload(tenantId, workloadName);
		refetchAll();
	} catch (err) {
		alert(err instanceof Error ? err.message : "Claim failed");
	} finally {
		setBusyInstances((prev) => {
			const next = new Set(prev);
			next.delete(instanceId);
			return next;
		});
	}
}
```

- [ ] **Step 2: Pass `onClaimInstance` to `WorkloadGroup` in the render**

Update the `<WorkloadGroup ... />` JSX inside the `tree.map(...)`:

```tsx
<WorkloadGroup
	key={node.workload.workloadId}
	node={node}
	expanded={expanded.has(node.workload.workloadId)}
	onToggle={() => toggleExpanded(node.workload.workloadId)}
	onAction={handleAction}
	onConnect={(id, name) => setConnectTarget({ instanceId: id, workloadName: name })}
	onClaimInstance={handleClaim}
	navigate={navigate}
	busyInstances={busyInstances}
	onClaim={refetchAll}
/>
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd apps/dashboard && bunx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Run unit tests**

```bash
bun test apps/ packages/
```

Expected: all pass (no dashboard component tests exist; this confirms nothing regressed).

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/pages/WorkloadList.tsx
git commit -m "feat(dashboard): add claim button to hibernated instance rows"
```

---

### Manual Verification Checklist

After committing, start the dev server and confirm:

1. A hibernated instance **with** a `tenantId` shows the `UserPlus` (claim) button before the Destroy button.
2. A hibernated instance **without** a `tenantId` (pool instance) shows no claim button.
3. Active instances are unaffected (still show Connect + Hibernate + Destroy).
4. Clicking claim shows the spinner (busy state) while the request is in flight.
5. On success, the instance row updates to `active`/`restoring` (via WebSocket refetch).
6. On failure, an `alert` dialog shows the error message.
