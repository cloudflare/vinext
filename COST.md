# vinext — AI Cost Tracker

This project is built almost entirely by AI (Claude Opus 4 via OpenCode). This file tracks the cumulative cost and token usage.

## Current Totals (as of 2026-02-14)

| Metric | Value |
|--------|-------|
| **Total cost** | **$274.85** |
| **Total tokens** | **374.4M** |
| Output tokens | 1,376,059 |
| Cache read tokens | 363,293,004 |
| Cache write tokens | 9,454,370 |
| Input tokens | 233,278 |
| Reasoning tokens | 3,328 |
| Sessions | 18 |
| Messages | 3,864 |
| Commits | 128 |
| Model | claude-opus-4-6 |

## What that bought

- Full Pages Router + App Router reimplementation
- 48 Next.js module shims (next/link, next/image, next/navigation, etc.)
- RSC (React Server Components) with streaming
- Server Actions, ISR, middleware, i18n, metadata API
- Production server with compression
- 388 vitest tests + 51 Playwright E2E tests
- 3 ecosystem library integrations (next-themes, next-view-transitions, nuqs)
- Benchmark infrastructure (3-way: Next.js vs Vite/Rollup vs Vite/Rolldown)
- CLI (vinext dev/build/start/lint)
- ~15,000 lines of TypeScript
- ~5,000 lines of tests
- 820-line project plan
- 370-line discoveries journal
- Comprehensive README

## Cost per unit

| Per... | Cost |
|--------|------|
| Per commit | $2.15 |
| Per test | $0.63 |
| Per feature | ~$5.50 |

## Session log

Updated automatically. Main session handles the bulk of the work; sub-agent sessions handle parallel tasks (search, rename, etc.)

| Date | Session | Cost | Messages | Notes |
|------|---------|------|----------|-------|
| Feb 13-14 | ses_3a6987be... (main) | $261.04 | 3,627 | Core development |
| Feb 14 | ses_3a19ffee... | $2.83 | 42 | Sub-agents |
| Feb 14 | ses_3a21f1d6... | $1.42 | 6 | Sub-agent |
| Various | 15 other sessions | $9.56 | 189 | Exploration, planning |

## Notes

- The vast majority of cost (~95%) is cache read tokens, which is expected for long coding sessions where the full codebase context is maintained across turns
- Output tokens (actual generated code/text) are only 1.4M — the rest is context
- Claude Opus 4 pricing: $15/M input, $75/M output, $1.875/M cache read, $3.75/M cache write
- OpenCode tracks cost per message in `~/.local/share/opencode/storage/message/`
