import { Cron } from "croner";
import type { TriggerDefinition, CronConfig, TriggerPayload } from "../config";
import type { DriverMap } from "../driver";
import type { Dispatcher } from "../dispatcher";
import { resolveTenantId } from "../resolve-tenant";
import type { Logger } from "@boilerhouse/o11y";

type CronTrigger = TriggerDefinition & { config: CronConfig };

export class CronAdapter {
	private jobs: Cron[] = [];
	private log?: Logger;

	start(triggers: CronTrigger[], dispatcher: Dispatcher, drivers?: DriverMap, log?: Logger): void {
		this.log = log;
		for (const trigger of triggers) {
			// Cron has no external event — resolve tenant from empty context.
			// Only { static: "..." } mappings will work here.
			const tenantId = resolveTenantId(trigger.tenant, {});
			const resolved = drivers?.get(trigger.name);
			const job = new Cron(trigger.config.schedule, () => {
				const payload: TriggerPayload = {
					text: "",
					source: "cron",
					raw: trigger.config.payload ?? {},
				};
				dispatcher
					.dispatch({
						triggerName: trigger.name,
						tenantId,
						workload: trigger.workload,
						payload,
						...(resolved && {
							driver: resolved.driver,
							driverConfig: resolved.driverConfig,
						}),
					})
					.catch((err) => {
						this.log?.error(
							{ trigger: trigger.name, err: err instanceof Error ? err.message : err },
							"Cron trigger dispatch failed",
						);
					});
			});
			this.jobs.push(job);
		}
	}

	stop(): void {
		for (const job of this.jobs) job.stop();
		this.jobs = [];
	}
}
