DROP INDEX IF EXISTS `tenants_instance_id_idx`;--> statement-breakpoint
DROP INDEX IF EXISTS `tenants_status_idx`;--> statement-breakpoint
ALTER TABLE `tenants` DROP COLUMN `status`;--> statement-breakpoint
ALTER TABLE `tenants` DROP COLUMN `status_detail`;--> statement-breakpoint
ALTER TABLE `tenants` DROP COLUMN `instance_id`;--> statement-breakpoint
CREATE TABLE `claims` (
	`claim_id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`instance_id` text,
	`status` text NOT NULL,
	`created_at` integer NOT NULL
);--> statement-breakpoint
CREATE UNIQUE INDEX `claims_tenant_id_unique` ON `claims` (`tenant_id`);--> statement-breakpoint
CREATE INDEX `claims_instance_id_idx` ON `claims` (`instance_id`);--> statement-breakpoint
CREATE INDEX `claims_status_idx` ON `claims` (`status`);
