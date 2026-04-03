CREATE TABLE `command_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`command_name` text NOT NULL,
	`command_context` text,
	`status` text NOT NULL,
	`settings_summary` text,
	`message` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `contest_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`request_fingerprint` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`contest_url` text,
	`contest_id` text,
	`error_message` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contest_runs_dedupe_key_idx` ON `contest_runs` (`dedupe_key`);--> statement-breakpoint
CREATE INDEX `contest_runs_request_fingerprint_idx` ON `contest_runs` (`request_fingerprint`);--> statement-breakpoint
CREATE TABLE `settings` (
	`id` integer PRIMARY KEY NOT NULL,
	`atcoder_user_id` text,
	`default_slot_minutes` integer DEFAULT 5 NOT NULL,
	`default_problem_count` integer DEFAULT 5 NOT NULL,
	`default_contest_duration_minutes` integer DEFAULT 100 NOT NULL,
	`default_penalty_seconds` integer DEFAULT 300 NOT NULL,
	`include_experimental_difficulty` integer DEFAULT false NOT NULL,
	`allow_other_sources` integer DEFAULT false NOT NULL,
	`exclude_recently_used_days` integer DEFAULT 14 NOT NULL,
	`visibility` text DEFAULT 'private' NOT NULL,
	`title_template` text,
	`memo_template` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `solved_problems` (
	`atcoder_user_id` text NOT NULL,
	`problem_id` text NOT NULL,
	`solved_at` integer,
	`synced_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`atcoder_user_id`, `problem_id`)
);
--> statement-breakpoint
CREATE INDEX `solved_problems_problem_id_idx` ON `solved_problems` (`problem_id`);--> statement-breakpoint
CREATE TABLE `sync_states` (
	`scope` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`full_sync_completed_at` integer,
	`last_synced_at` integer,
	`last_checkpoint` text,
	`last_success_checkpoint` text,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `command_logs_command_name_idx` ON `command_logs` (`command_name`);--> statement-breakpoint
CREATE INDEX `command_logs_created_at_idx` ON `command_logs` (`created_at`);
