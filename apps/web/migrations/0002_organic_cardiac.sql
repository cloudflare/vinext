-- Performance metrics use generic scenario rows. Client bundle gzip size is
-- stored with scenario_id = 'client-bundle-gzip', unit = 'bytes', and byte
-- counts in the sample statistic columns.
CREATE TABLE `performance_measurements` (
	`run_id` text NOT NULL,
	`benchmark_id` text NOT NULL,
	`scenario_id` text NOT NULL,
	`suite` text NOT NULL,
	`label` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`implementation_id` text NOT NULL,
	`implementation_label` text NOT NULL,
	`unit` text NOT NULL,
	`lower_is_better` integer DEFAULT true NOT NULL,
	`rounds` integer NOT NULL,
	`mean_value` real NOT NULL,
	`median_value` real NOT NULL,
	`standard_deviation_value` real NOT NULL,
	`min_value` real NOT NULL,
	`max_value` real NOT NULL,
	`q1_value` real NOT NULL,
	`q3_value` real NOT NULL,
	`outliers` integer NOT NULL,
	`flame_graph_json` text,
	PRIMARY KEY(`run_id`, `benchmark_id`),
	FOREIGN KEY (`run_id`) REFERENCES `performance_runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_performance_measurements_dashboard` ON `performance_measurements` (`run_id`,`suite`,`label`,`implementation_label`);--> statement-breakpoint
CREATE TABLE `performance_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`commit_sha` text NOT NULL,
	`base_sha` text,
	`pull_request` integer,
	`measured_at` text NOT NULL,
	`provider` text NOT NULL,
	`instrument` text NOT NULL,
	`repository` text NOT NULL,
	`system_json` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_performance_runs_pr_latest` ON `performance_runs` (`pull_request`,`measured_at`) WHERE "performance_runs"."kind" = 'pull_request';--> statement-breakpoint
CREATE INDEX `idx_performance_runs_main_commit` ON `performance_runs` (`commit_sha`,`measured_at`) WHERE "performance_runs"."kind" = 'main';--> statement-breakpoint
CREATE INDEX `idx_performance_runs_main_latest` ON `performance_runs` (`measured_at`) WHERE "performance_runs"."kind" = 'main';
