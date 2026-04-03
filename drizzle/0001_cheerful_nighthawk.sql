CREATE TABLE `problem_catalog` (
	`problem_id` text PRIMARY KEY NOT NULL,
	`contest_id` text NOT NULL,
	`problem_index` text,
	`title` text NOT NULL,
	`difficulty` integer,
	`is_experimental` integer DEFAULT false NOT NULL,
	`source_category` text NOT NULL,
	`updated_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `problem_catalog_contest_id_idx` ON `problem_catalog` (`contest_id`);--> statement-breakpoint
CREATE INDEX `problem_catalog_source_category_idx` ON `problem_catalog` (`source_category`);--> statement-breakpoint
CREATE INDEX `problem_catalog_difficulty_idx` ON `problem_catalog` (`difficulty`);--> statement-breakpoint
CREATE TABLE `problem_usage_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`problem_id` text NOT NULL,
	`used_at` integer NOT NULL,
	`contest_run_id` integer,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `problem_usage_logs_problem_id_idx` ON `problem_usage_logs` (`problem_id`);--> statement-breakpoint
CREATE INDEX `problem_usage_logs_used_at_idx` ON `problem_usage_logs` (`used_at`);