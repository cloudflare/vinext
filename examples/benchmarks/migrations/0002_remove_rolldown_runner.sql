-- Remove vinext_rolldown benchmark data.
-- The Vite 7 / Rollup runner was identical to the Vite 8 / Rolldown runner
-- (both resolved to the same Vite version), so the data was duplicated.
-- Going forward only 'nextjs' and 'vinext' runners are tracked.
DELETE FROM benchmark_results WHERE runner = 'vinext_rolldown';
