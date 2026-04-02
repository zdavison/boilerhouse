# Hibernated Instance Claim Button

## Summary

Add a claim button to hibernated instance rows in the dashboard `WorkloadList` page. When a hibernated instance has a known tenant, a single click reclaims it for that tenant — no text input needed.

## Context

Instances go `active → hibernated` when idle timeout fires or the hibernate button is pressed. The tenant's data is preserved in an overlay. The existing claim flow (`POST /tenants/:id/claim`) already handles this via the `cold+data` source path — it finds the hibernated instance and restores it.

The workload header already has a `ClaimCell` (UserPlus icon, info/blue variant) for claiming a new tenant. Hibernated instances with an existing tenant should expose the same one-click action inline on the instance row.

## Design

**Trigger condition:** `instance.status === "hibernated" && instance.tenantId !== null`

**Button:** `UserPlus` icon, `info` variant `IconButton` — same style as the workload-level claim button.

**Behavior:**
1. Click adds the instance to `busyInstances` (shows spinner, disables button).
2. Calls `api.claimWorkload(instance.tenantId, workloadName)`.
3. On success: `refetchAll()` is called (same as other actions).
4. On error: `alert(...)` (same as existing `handleAction` error path).

**Placement:** Inside the existing actions `<div>` in `InstanceRow`, before the Destroy button, guarded by the hibernated+tenantId condition.

## Changes

- `apps/dashboard/src/pages/WorkloadList.tsx` only.
- `InstanceRow` gets an `onClaim: (instanceId: string, tenantId: string) => void` prop.
- `InstanceSection` and `WorkloadGroup` thread `onClaim` down.
- `handleAction` in `WorkloadList` extended to handle the claim case, or a separate `handleClaim` function added.
- No API, backend, or schema changes required.

## Non-goals

- No text input for tenant override (tenant is already known from the row).
- No changes to `ClaimCell` or the workload-header claim flow.
- No changes outside `WorkloadList.tsx`.
