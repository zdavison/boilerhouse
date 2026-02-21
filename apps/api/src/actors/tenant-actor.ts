import { eq } from "drizzle-orm";
import type { TenantId, TenantStatus, TenantEvent } from "@boilerhouse/core";
import { tenantTransition } from "@boilerhouse/core";
import type { DrizzleDb } from "@boilerhouse/db";
import { tenants } from "@boilerhouse/db";

export class TenantActor {
	constructor(
		private readonly db: DrizzleDb,
		private readonly tenantId: TenantId,
	) {}

	get status(): TenantStatus {
		const row = this.db
			.select({ status: tenants.status })
			.from(tenants)
			.where(eq(tenants.tenantId, this.tenantId))
			.get();
		if (!row) throw new Error(`Tenant not found: ${this.tenantId}`);
		return row.status as TenantStatus;
	}

	/** Validates the event, persists the new status, and returns it. */
	send(event: TenantEvent): TenantStatus {
		const current = this.status;
		const next = tenantTransition(current, event);
		this.db
			.update(tenants)
			.set({ status: next })
			.where(eq(tenants.tenantId, this.tenantId))
			.run();
		return next;
	}

	/** Validates the event without persisting. Use for fail-fast guards. */
	validate(event: TenantEvent): TenantStatus {
		return tenantTransition(this.status, event);
	}

	/** Bypasses the state machine and writes status directly (recovery only). */
	forceStatus(status: TenantStatus): void {
		this.db
			.update(tenants)
			.set({ status })
			.where(eq(tenants.tenantId, this.tenantId))
			.run();
	}
}
