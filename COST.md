# vinext — AI Cost Tracker

This project is built almost entirely by AI (Claude Opus 4 via OpenCode). This file tracks the cumulative cost and token usage.

## Current Totals (as of 2026-02-16)

| Metric | Value |
|--------|-------|
| **Total cost** | **~$350+** |
| **Sessions** | **631** (nextcompat project) |
| **Commits** | **207** |
| **Model** | claude-opus-4-6 |

_Note: OpenCode's cost tracking format changed between versions. The $350+ figure is an estimate based on $323.83 tracked through Feb 14 plus continued development on Feb 14-16 (issues #37, #22, #21, benchmarks, docs updates). Most sessions are sub-agent sessions (search, explore, etc.) spawned by the main session._

## What that bought

- Full Pages Router + App Router reimplementation
- 30+ Next.js module shims (next/link, next/image, next/navigation, next/cache, etc.)
- RSC (React Server Components) with streaming
- `"use cache"` directive with `cacheLife()`/`cacheTag()` and pluggable cache backend
- Server Actions, ISR, middleware, i18n (Accept-Language, NEXT_LOCALE cookie, locale prop), metadata API
- `connection()` dynamic rendering
- Production server with compression + streaming SSR
- Static export with HTTP-served E2E verification
- Smart deploy (`vinext deploy`) with auto-detection of ESM, MDX, CJS configs, native modules
- Compatibility scanner (`vinext check`)
- 844 vitest tests + 278 Playwright E2E tests
- 3 ecosystem library integrations (next-themes, next-view-transitions, nuqs)
- Benchmark infrastructure (3-way: Next.js vs Vite/Rollup vs Vite/Rolldown)
- CLI (vinext dev/build/start/deploy/check/lint)
- ~45,000 lines of TypeScript source
- ~25,000 lines of tests
- 849-line project plan
- 580-line discoveries journal
- Comprehensive README
- Live deployment on Cloudflare Workers (next-app-router-playground)

## Cost per unit

| Per... | Cost |
|--------|------|
| Per commit | ~$1.69 |
| Per test | ~$0.31 |
| Per 1K lines of code | ~$5.00 |

## Session log

The project uses 631 tracked sessions in OpenCode. The vast majority are sub-agent sessions spawned automatically for parallel tasks (code search, file exploration, rename operations, etc.).

| Date | Description | Notes |
|------|------------|-------|
| Feb 13-14 | Core development | Pages/App Router, shims, routing, SSR, ISR, server actions, RSC, middleware, metadata, i18n, streaming, hydration, error handling, ecosystem libs, benchmarks, CLI |
| Feb 14 | Issues #6, #19, #14, #4, #8, #11, #16 | Config features, fetch cache tests, connection(), "use cache", ISR E2E, server-only/client-only, compatibility scanner |
| Feb 14-16 | Issues #37, #22, #21 | Smart deploy, streaming SSR, static export E2E |
| Feb 16 | Benchmarks + docs | Re-ran benchmarks at cc7d0f3, updated README + COST.md |

## Notes

- The vast majority of cost (~95%) is cache read tokens, which is expected for long coding sessions where the full codebase context is maintained across turns
- Claude Opus 4 pricing: $15/M input, $75/M output, $1.875/M cache read, $3.75/M cache write
- OpenCode tracks sessions in `~/.local/share/opencode/storage/session/`
