PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tenants` (
	`tenant_id` text NOT NULL,
	`workload_id` text NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`status_detail` text,
	`instance_id` text,
	`last_snapshot_id` text,
	`data_overlay_ref` text,
	`last_activity` integer,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`tenant_id`, `workload_id`),
	FOREIGN KEY (`workload_id`) REFERENCES `workloads`(`workload_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_tenants`("tenant_id", "workload_id", "status", "status_detail", "instance_id", "last_snapshot_id", "data_overlay_ref", "last_activity", "created_at") SELECT "tenant_id", "workload_id", "status", "status_detail", "instance_id", "last_snapshot_id", "data_overlay_ref", "last_activity", "created_at" FROM `tenants`;--> statement-breakpoint
DROP TABLE `tenants`;--> statement-breakpoint
ALTER TABLE `__new_tenants` RENAME TO `tenants`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `tenants_workload_id_idx` ON `tenants` (`workload_id`);--> statement-breakpoint
CREATE INDEX `tenants_instance_id_idx` ON `tenants` (`instance_id`);--> statement-breakpoint
CREATE INDEX `tenants_status_idx` ON `tenants` (`status`);