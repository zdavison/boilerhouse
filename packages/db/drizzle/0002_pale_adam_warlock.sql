ALTER TABLE `instances` ADD `status_detail` text;--> statement-breakpoint
ALTER TABLE `nodes` ADD `status_detail` text;--> statement-breakpoint
ALTER TABLE `snapshots` ADD `status_detail` text;--> statement-breakpoint
ALTER TABLE `tenants` ADD `status_detail` text;--> statement-breakpoint
ALTER TABLE `workloads` ADD `status_detail` text;