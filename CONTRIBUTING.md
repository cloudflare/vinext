# Contributing to vinext

vinext was born from an experiment in pushing AI to its limits. Almost every line of code in this repo was written by AI, and every pull request is both created and reviewed by AI agents. We welcome human contributions, but if you want to have a good time in this repo, you're going to want to use AI.

## Recommended setup

We use [OpenCode](https://opencode.ai) with Claude Opus 4.6, set to max thinking. This is the same setup that built the project.

## Before you open a PR

1. **Run the test suite.** `pnpm test` runs Vitest. `pnpm run test:e2e` runs Playwright.
2. **Add tests for new functionality.** Unit tests go in `tests/*.test.ts`. Browser-level tests go in `tests/e2e/`.
3. **Run the formatter, linter, and type checker.** `pnpm run fmt:check` (oxfmt), `pnpm run lint` (oxlint), and `pnpm run typecheck` (tsgo).
4. **Read `AGENTS.md`.** It has the architecture context, key gotchas, and development workflow that will save you (and your AI) time.

## AI code review

Every PR goes through AI code review. When you open a PR, a contributor with write access will request a review from **BigBonk** (Claude Opus 4.6, max thinking mode). External contributors can't trigger this directly.

Our process is to iterate on BigBonk's feedback until there are no unresolved comments. That doesn't mean you have to accept every suggestion verbatim, but we've found it to be very good at finding real problems and very useful for debugging this codebase. Expect multiple review rounds on larger PRs.

**Our bias is towards merging.** This is a new project with known gaps, and we're trying to fill them as fast as possible. We want to get PRs in, not block them. If your contribution moves things forward, we'll work with you to get it landed.

At a maintainer's discretion, we may push BigBonk's recommended changes directly into your PR and merge it, or we may create a new PR based on your work. When we do this, we always try to preserve the original author credit. If that ever doesn't happen, please let us know and we'll fix it.

## Debugging

For browser-level debugging (verifying rendered output, client-side navigation, hydration behavior), we recommend [agent-browser](https://github.com/vercel-labs/agent-browser). Unit tests miss a lot of subtle browser issues. agent-browser has been effective at catching them throughout this project.

## What to work on

Check the [open issues](https://github.com/cloudflare/vinext/issues). If you're looking to contribute, those are a good place to start.

## Project structure

See `AGENTS.md` for the full project structure, key files, architecture patterns, and development workflow.
