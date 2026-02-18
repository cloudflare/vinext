-- Benchmark results: one row per runner per commit.
-- Three rows per benchmark run (nextjs, vinext, vinext_rolldown).
CREATE TABLE IF NOT EXISTS benchmark_results (
  id INTEGER PRIMARY KEY AUTOINCREMENT,

  -- Commit info
  commit_sha TEXT NOT NULL,
  commit_short TEXT NOT NULL,
  commit_message TEXT,
  commit_date TEXT NOT NULL,

  -- Run metadata
  run_date TEXT NOT NULL,
  runner TEXT NOT NULL CHECK(runner IN ('nextjs', 'vinext', 'vinext_rolldown')),

  -- Build time (ms)
  build_time_mean REAL,
  build_time_stddev REAL,
  build_time_min REAL,
  build_time_max REAL,

  -- Bundle size (bytes)
  bundle_size_raw INTEGER,
  bundle_size_gzip INTEGER,
  bundle_file_count INTEGER,

  -- Dev server cold start
  dev_cold_start_ms REAL,
  dev_peak_rss_kb REAL,

  -- SSR throughput (future)
  ssr_rps REAL,
  ssr_ttfb_ms REAL,

  -- System info
  platform TEXT,
  arch TEXT,
  node_version TEXT,
  cpu_count INTEGER,
  run_count INTEGER,

  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_commit_sha ON benchmark_results(commit_sha);
CREATE INDEX IF NOT EXISTS idx_run_date ON benchmark_results(run_date);
CREATE INDEX IF NOT EXISTS idx_runner ON benchmark_results(runner);
CREATE INDEX IF NOT EXISTS idx_commit_date ON benchmark_results(commit_date);
