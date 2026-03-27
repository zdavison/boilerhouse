ALTER TABLE `claims` ADD `workload_id` text NOT NULL DEFAULT '';--> statement-breakpoint
DROP INDEX IF EXISTS `claims_tenant_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `claims_tenant_workload_uniq` ON `claims` (`tenant_id`, `workload_id`);
