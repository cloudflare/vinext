ALTER TABLE `compat_file_results` ADD `router` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_compat_file_results_kind_router` ON `compat_file_results` (`kind`,`router`);