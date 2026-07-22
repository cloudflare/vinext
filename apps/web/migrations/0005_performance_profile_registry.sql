CREATE TABLE `performance_profile_objects` (
	`object_key` text PRIMARY KEY NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
INSERT INTO `performance_profile_objects` (`object_key`)
SELECT DISTINCT `profile_object_key`
FROM `performance_measurements`
WHERE `profile_object_key` IS NOT NULL;
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_performance_measurements` (
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
	`profile_object_key` text,
	PRIMARY KEY(`run_id`, `benchmark_id`),
	FOREIGN KEY (`run_id`) REFERENCES `performance_runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`profile_object_key`) REFERENCES `performance_profile_objects`(`object_key`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_performance_measurements`("run_id", "benchmark_id", "scenario_id", "suite", "label", "description", "implementation_id", "implementation_label", "unit", "lower_is_better", "rounds", "mean_value", "median_value", "standard_deviation_value", "min_value", "max_value", "q1_value", "q3_value", "outliers", "flame_graph_json", "profile_object_key") SELECT "run_id", "benchmark_id", "scenario_id", "suite", "label", "description", "implementation_id", "implementation_label", "unit", "lower_is_better", "rounds", "mean_value", "median_value", "standard_deviation_value", "min_value", "max_value", "q1_value", "q3_value", "outliers", "flame_graph_json", "profile_object_key" FROM `performance_measurements`;--> statement-breakpoint
DROP TABLE `performance_measurements`;--> statement-breakpoint
ALTER TABLE `__new_performance_measurements` RENAME TO `performance_measurements`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_performance_measurements_dashboard` ON `performance_measurements` (`run_id`,`suite`,`label`,`implementation_label`);
