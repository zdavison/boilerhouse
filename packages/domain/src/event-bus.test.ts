import { describe, test, expect } from "bun:test";
import { EventBus } from "./event-bus";
import type { DomainEvent } from "./event-bus";
import type { InstanceId, TenantId, WorkloadId } from "@boilerhouse/core";

describe("EventBus", () => {
	test("emits events to listeners", () => {
		const bus = new EventBus();
		const received: DomainEvent[] = [];

		bus.on((event) => received.push(event));

		const event: DomainEvent = {
			type: "instance.state",
			instanceId: "inst-1" as InstanceId,
			status: "active",
		};

		bus.emit(event);

		expect(received).toHaveLength(1);
		expect(received[0]).toEqual(event);
	});

	test("emits to multiple listeners", () => {
		const bus = new EventBus();
		let count = 0;

		bus.on(() => count++);
		bus.on(() => count++);

		bus.emit({
			type: "instance.state",
			instanceId: "inst-1" as InstanceId,
			status: "destroyed",
		});

		expect(count).toBe(2);
	});

	test("off removes a listener", () => {
		const bus = new EventBus();
		const received: DomainEvent[] = [];
		const handler = (event: DomainEvent) => received.push(event);

		bus.on(handler);
		bus.emit({
			type: "instance.state",
			instanceId: "inst-1" as InstanceId,
			status: "active",
		});
		expect(received).toHaveLength(1);

		bus.off(handler);
		bus.emit({
			type: "instance.state",
			instanceId: "inst-2" as InstanceId,
			status: "active",
		});
		expect(received).toHaveLength(1);
	});

	test("listenerCount reflects attached listeners", () => {
		const bus = new EventBus();

		expect(bus.listenerCount()).toBe(0);

		const handler = () => {};
		bus.on(handler);
		expect(bus.listenerCount()).toBe(1);

		bus.off(handler);
		expect(bus.listenerCount()).toBe(0);
	});

	test("handles tenant events", () => {
		const bus = new EventBus();
		const received: DomainEvent[] = [];
		bus.on((event) => received.push(event));

		bus.emit({
			type: "tenant.claimed",
			tenantId: "t-1" as TenantId,
			instanceId: "i-1" as InstanceId,
			workloadId: "w-1" as WorkloadId,
			source: "golden",
		});

		bus.emit({
			type: "tenant.released",
			tenantId: "t-1" as TenantId,
			instanceId: "i-1" as InstanceId,
		});

		expect(received).toHaveLength(2);
		expect(received[0]!.type).toBe("tenant.claimed");
		expect(received[1]!.type).toBe("tenant.released");
	});
});
