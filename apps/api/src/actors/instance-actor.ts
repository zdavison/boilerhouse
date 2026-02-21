import { eq } from "drizzle-orm";
import type { InstanceId, InstanceStatus, InstanceEvent } from "@boilerhouse/core";
import { transition } from "@boilerhouse/core";
import type { DrizzleDb } from "@boilerhouse/db";
import { instances } from "@boilerhouse/db";

export class InstanceActor {
	constructor(
		private readonly db: DrizzleDb,
		private readonly instanceId: InstanceId,
	) {}

	get status(): InstanceStatus {
		const row = this.db
			.select({ status: instances.status })
			.from(instances)
			.where(eq(instances.instanceId, this.instanceId))
			.get();
		if (!row) throw new Error(`Instance not found: ${this.instanceId}`);
		return row.status as InstanceStatus;
	}

	/** Validates the event, persists the new status, and returns it. */
	send(event: InstanceEvent): InstanceStatus {
		const current = this.status;
		const next = transition(current, event);
		this.db
			.update(instances)
			.set({ status: next })
			.where(eq(instances.instanceId, this.instanceId))
			.run();
		return next;
	}

	/** Validates the event without persisting. Use for fail-fast guards. */
	validate(event: InstanceEvent): InstanceStatus {
		return transition(this.status, event);
	}

	/** Bypasses the state machine and writes status directly (recovery only). */
	forceStatus(status: InstanceStatus): void {
		this.db
			.update(instances)
			.set({ status })
			.where(eq(instances.instanceId, this.instanceId))
			.run();
	}
}
