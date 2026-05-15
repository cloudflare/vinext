CREATE TABLE `compat_file_results` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`kind` text NOT NULL,
	`suite` text NOT NULL,
	`status` text NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`passed` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	`skipped` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `compat_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_compat_file_results_run` ON `compat_file_results` (`run_id`);--> statement-breakpoint
CREATE INDEX `idx_compat_file_results_kind_suite` ON `compat_file_results` (`kind`,`suite`);--> statement-breakpoint
CREATE TABLE `compat_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`run_key` text NOT NULL,
	`vinext_ref` text,
	`next_ref` text,
	`commit_sha` text,
	`created_at` integer NOT NULL,
	`total` integer DEFAULT 0 NOT NULL,
	`passed` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	`skipped` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `compat_runs_kind_run_key` ON `compat_runs` (`kind`,`run_key`);--> statement-breakpoint
CREATE INDEX `idx_compat_runs_kind_created` ON `compat_runs` (`kind`,`created_at`);