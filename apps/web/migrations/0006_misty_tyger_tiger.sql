ALTER TABLE `performance_measurements` ADD `paired_baseline_rounds` integer;--> statement-breakpoint
ALTER TABLE `performance_measurements` ADD `paired_baseline_mean_value` real;--> statement-breakpoint
ALTER TABLE `performance_measurements` ADD `paired_baseline_median_value` real;--> statement-breakpoint
ALTER TABLE `performance_measurements` ADD `paired_baseline_standard_deviation_value` real;--> statement-breakpoint
ALTER TABLE `performance_measurements` ADD `paired_baseline_min_value` real;--> statement-breakpoint
ALTER TABLE `performance_measurements` ADD `paired_baseline_max_value` real;--> statement-breakpoint
ALTER TABLE `performance_measurements` ADD `paired_baseline_q1_value` real;--> statement-breakpoint
ALTER TABLE `performance_measurements` ADD `paired_baseline_q3_value` real;--> statement-breakpoint
ALTER TABLE `performance_measurements` ADD `paired_baseline_outliers` integer;