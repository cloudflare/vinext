# fix: merge top-level optimizeDeps with per-environment config

## Summary

Fixes #538

vinext's `config()` hook was creating per-environment `optimizeDeps` objects from scratch, discarding any `exclude` or `include` entries that other Vite plugins (e.g. `@lingui/vite-plugin`) had added to the top-level `config.optimizeDeps` during their own `config` hooks.

This PR captures the incoming `config.optimizeDeps.exclude` and `config.optimizeDeps.include` arrays before building the per-environment configs, then merges them (with deduplication via `Set`) into each environment:

- **rsc**: `exclude` now includes incoming excludes + `["vinext", "@vercel/og"]`
- **ssr**: `exclude` now includes incoming excludes + `["vinext", "@vercel/og"]`
- **client**: `exclude` now includes incoming excludes + `["vinext", "@vercel/og", ...serverExternalPackages]`; `include` now includes incoming includes + React packages

### Changes

- `packages/vinext/src/index.ts` — Read `config.optimizeDeps?.exclude` and `config.optimizeDeps?.include` at the top of the environments block, then spread them into each environment's `optimizeDeps` using `[...new Set([...incoming, ...vinextOwn])]`
- `tests/build-optimization.test.ts` — New test that passes `optimizeDeps.exclude` and `optimizeDeps.include` via the mock config (simulating an earlier plugin like `@lingui/vite-plugin`) and verifies those entries appear in all three environments alongside vinext's own entries

## Test plan

- [x] New unit test: passes top-level `optimizeDeps.exclude` (`@lingui/macro`, `@lingui/core/macro`) and `optimizeDeps.include` (`some-lib`) via mock config, verifies they appear in rsc/ssr/client environments alongside vinext's own entries
- [x] Existing `optimizeDeps.exclude` tests still pass (66/66 in `build-optimization.test.ts`)
- [x] `pnpm run fmt:check` — passes
- [x] `pnpm run lint` — 0 warnings, 0 errors
- [x] `pnpm run typecheck` — passes

https://claude.ai/code/session_01T7kpjyEcsZTUG6wHscx3nb
