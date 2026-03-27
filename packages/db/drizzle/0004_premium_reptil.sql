CREATE TABLE `tenant_secrets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`tenant_id` text NOT NULL,
	`name` text NOT NULL,
	`encrypted_value` text NOT NULL,
	`iv` text NOT NULL,
	`auth_tag` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tenant_secrets_tenant_id_idx` ON `tenant_secrets` (`tenant_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tenant_secrets_tenant_name_uniq` ON `tenant_secrets` (`tenant_id`,`name`);