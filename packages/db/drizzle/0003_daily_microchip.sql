CREATE TABLE `build_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workload_id` text NOT NULL,
	`text` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `build_logs_workload_id_idx` ON `build_logs` (`workload_id`);