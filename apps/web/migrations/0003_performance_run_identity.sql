DELETE FROM `performance_measurements`
WHERE `run_id` IN (
  SELECT `id`
  FROM (
    SELECT
      `id`,
      ROW_NUMBER() OVER (
        PARTITION BY `kind`, `commit_sha`
        ORDER BY `measured_at` DESC, `created_at` DESC, `id` DESC
      ) AS `duplicate_rank`
    FROM `performance_runs`
  )
  WHERE `duplicate_rank` > 1
);--> statement-breakpoint
DELETE FROM `performance_runs`
WHERE `id` IN (
  SELECT `id`
  FROM (
    SELECT
      `id`,
      ROW_NUMBER() OVER (
        PARTITION BY `kind`, `commit_sha`
        ORDER BY `measured_at` DESC, `created_at` DESC, `id` DESC
      ) AS `duplicate_rank`
    FROM `performance_runs`
  )
  WHERE `duplicate_rank` > 1
);--> statement-breakpoint
CREATE UNIQUE INDEX `performance_runs_kind_commit`
ON `performance_runs` (`kind`, `commit_sha`);
