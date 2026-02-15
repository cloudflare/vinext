# vinext — AI Cost Tracker

This project is built almost entirely by AI (Claude Opus 4 via OpenCode). This file tracks the cumulative cost and token usage.

## Current Totals (as of 2026-02-14)

| Metric | Value |
|--------|-------|
| **Total cost** | **$323.83** |
| **Output tokens** | **1,545,528** |
| Sessions | 21+ |
| Messages | 4,678+ |
| Commits | 164 |
| Model | claude-opus-4-6 |

_Note: OpenCode's cost tracking format changed — cache read/write tokens are no longer tracked separately in storage. The $323.83 figure reflects the main session plus sub-agent costs._

## What that bought

- Full Pages Router + App Router reimplementation
- 48 Next.js module shims (next/link, next/image, next/navigation, etc.)
- RSC (React Server Components) with streaming
- Server Actions, ISR, middleware, i18n (Accept-Language, NEXT_LOCALE cookie, locale prop), metadata API
- Production server with compression
- 590 vitest tests + 81 Playwright E2E tests
- 3 ecosystem library integrations (next-themes, next-view-transitions, nuqs)
- Benchmark infrastructure (3-way: Next.js vs Vite/Rollup vs Vite/Rolldown)
- CLI (vinext dev/build/start/lint)
- ~16,000 lines of TypeScript
- ~8,000 lines of tests
- 820-line project plan
- 440-line discoveries journal
- Comprehensive README

## Cost per unit

| Per... | Cost |
|--------|------|
| Per commit | $1.97 |
| Per test | $0.48 |
| Per feature | ~$5.50 |

## Session log

Updated automatically. Main session handles the bulk of the work; sub-agent sessions handle parallel tasks (search, rename, etc.)

| Date | Session | Cost | Messages | Notes |
|------|---------|------|----------|-------|
| Feb 13-14 | ses_3a6987be... (main) | $322.78 | 4,651 | Core development (ongoing) |
| Feb 14 | ses_3a084744... | $0.31 | 9 | Sub-agent: i18n locale redirect code search |
| Feb 14 | ses_3a079c6e... | $0.51 | 11 | Sub-agent: middleware + rewrite flow analysis |
| Feb 14 | ses_3a073a63... | $0.23 | 7 | Sub-agent: searchParams handling search |
| Various | 15+ other sessions | ~$10 | ~200 | Exploration, planning, rename |

## Notes

- The vast majority of cost (~95%) is cache read tokens, which is expected for long coding sessions where the full codebase context is maintained across turns
- Output tokens (actual generated code/text) are only 1.4M — the rest is context
- Claude Opus 4 pricing: $15/M input, $75/M output, $1.875/M cache read, $3.75/M cache write
- OpenCode tracks cost per message in `~/.local/share/opencode/storage/message/`
