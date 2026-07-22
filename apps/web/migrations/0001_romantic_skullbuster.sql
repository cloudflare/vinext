CREATE TABLE `compat_suite_meta` (
	`suite` text PRIMARY KEY NOT NULL,
	`router` text NOT NULL,
	`classified_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_compat_suite_meta_router` ON `compat_suite_meta` (`router`);
