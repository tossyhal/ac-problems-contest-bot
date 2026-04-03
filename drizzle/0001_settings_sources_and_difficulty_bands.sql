ALTER TABLE `settings` ADD `include_abc` integer DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE `settings` ADD `include_arc` integer DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE `settings` ADD `include_agc` integer DEFAULT true NOT NULL;
--> statement-breakpoint
CREATE TABLE `setting_difficulty_bands` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`setting_id` integer NOT NULL,
	`sort_order` integer NOT NULL,
	`difficulty_min` integer NOT NULL,
	`difficulty_max` integer NOT NULL,
	`problem_count` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`setting_id`) REFERENCES `settings`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `setting_difficulty_bands_setting_sort_order_idx` ON `setting_difficulty_bands` (`setting_id`, `sort_order`);--> statement-breakpoint
CREATE INDEX `setting_difficulty_bands_setting_id_idx` ON `setting_difficulty_bands` (`setting_id`);
