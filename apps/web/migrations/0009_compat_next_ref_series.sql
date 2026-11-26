DROP INDEX `compat_runs_kind_run_key`;--> statement-breakpoint
DROP INDEX `idx_compat_runs_kind_created`;--> statement-breakpoint
CREATE UNIQUE INDEX `compat_runs_kind_next_ref_run_key` ON `compat_runs` (`kind`,`next_ref`,`run_key`);--> statement-breakpoint
CREATE INDEX `idx_compat_runs_kind_next_ref_created` ON `compat_runs` (`kind`,`next_ref`,`created_at`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_compat_suite_meta` (
	`next_ref` text NOT NULL,
	`suite` text NOT NULL,
	`router` text NOT NULL,
	`classified_at` integer NOT NULL,
	PRIMARY KEY(`next_ref`, `suite`)
);
--> statement-breakpoint
-- Every classification so far came from the v16.2.6 checkout.
INSERT INTO `__new_compat_suite_meta`("next_ref", "suite", "router", "classified_at") SELECT 'v16.2.6', "suite", "router", "classified_at" FROM `compat_suite_meta`;--> statement-breakpoint
DROP TABLE `compat_suite_meta`;--> statement-breakpoint
ALTER TABLE `__new_compat_suite_meta` RENAME TO `compat_suite_meta`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_compat_suite_meta_router` ON `compat_suite_meta` (`router`);