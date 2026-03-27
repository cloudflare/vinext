-- Remove vinext_rolldown benchmark data.
-- The Vite 7 / Rolldown runner was identical to the Vite 8 / Rollup runner
-- (both resolved to the same Vite version), so the data was duplicated.
-- Going forward only 'nextjs' and 'vinext' runners are tracked.
DELETE FROM benchmark_results WHERE runner = 'vinext_rolldown';
