CREATE TABLE `activity_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`instance_id` text,
	`workload_id` text,
	`node_id` text,
	`tenant_id` text,
	`event` text NOT NULL,
	`metadata` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `activity_log_instance_id_idx` ON `activity_log` (`instance_id`);--> statement-breakpoint
CREATE INDEX `activity_log_tenant_id_idx` ON `activity_log` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `activity_log_event_idx` ON `activity_log` (`event`);--> statement-breakpoint
CREATE INDEX `activity_log_created_at_idx` ON `activity_log` (`created_at`);--> statement-breakpoint
CREATE TABLE `instances` (
	`instance_id` text PRIMARY KEY NOT NULL,
	`workload_id` text NOT NULL,
	`node_id` text NOT NULL,
	`tenant_id` text,
	`status` text DEFAULT 'starting' NOT NULL,
	`runtime_meta` text,
	`last_activity` integer,
	`claimed_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workload_id`) REFERENCES `workloads`(`workload_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`node_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `instances_workload_id_idx` ON `instances` (`workload_id`);--> statement-breakpoint
CREATE INDEX `instances_node_id_idx` ON `instances` (`node_id`);--> statement-breakpoint
CREATE INDEX `instances_tenant_id_idx` ON `instances` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `instances_status_idx` ON `instances` (`status`);--> statement-breakpoint
CREATE TABLE `nodes` (
	`node_id` text PRIMARY KEY NOT NULL,
	`runtime_type` text NOT NULL,
	`capacity` text NOT NULL,
	`status` text DEFAULT 'online' NOT NULL,
	`last_heartbeat` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `snapshots` (
	`snapshot_id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`instance_id` text NOT NULL,
	`tenant_id` text,
	`workload_id` text NOT NULL,
	`node_id` text NOT NULL,
	`status` text DEFAULT 'ready' NOT NULL,
	`vmstate_path` text NOT NULL,
	`memory_path` text,
	`size_bytes` integer NOT NULL,
	`runtime_meta` text,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workload_id`) REFERENCES `workloads`(`workload_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`node_id`) REFERENCES `nodes`(`node_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `snapshots_workload_id_idx` ON `snapshots` (`workload_id`);--> statement-breakpoint
CREATE INDEX `snapshots_node_id_idx` ON `snapshots` (`node_id`);--> statement-breakpoint
CREATE INDEX `snapshots_tenant_id_idx` ON `snapshots` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `snapshots_type_idx` ON `snapshots` (`type`);--> statement-breakpoint
CREATE INDEX `snapshots_status_idx` ON `snapshots` (`status`);--> statement-breakpoint
CREATE TABLE `tenants` (
	`tenant_id` text PRIMARY KEY NOT NULL,
	`workload_id` text NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`instance_id` text,
	`last_snapshot_id` text,
	`data_overlay_ref` text,
	`last_activity` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workload_id`) REFERENCES `workloads`(`workload_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `tenants_workload_id_idx` ON `tenants` (`workload_id`);--> statement-breakpoint
CREATE INDEX `tenants_instance_id_idx` ON `tenants` (`instance_id`);--> statement-breakpoint
CREATE INDEX `tenants_status_idx` ON `tenants` (`status`);--> statement-breakpoint
CREATE TABLE `workloads` (
	`workload_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`version` text NOT NULL,
	`config` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `workloads_name_version_uniq` ON `workloads` (`name`,`version`);