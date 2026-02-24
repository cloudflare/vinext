# Contributing to vinext

vinext was born from an experiment in pushing AI to its limits. Almost every line of code in this repo was written by AI, and every pull request is both created and reviewed by AI agents. We welcome human contributions, but if you want to have a good time in this repo, you're going to want to use AI.

## Recommended setup

We use [OpenCode](https://opencode.ai) with Claude Opus 4.6, set to max thinking. This is the same setup that built the project.

## Before you open a PR

1. **Run the test suite.** `pnpm test` runs Vitest. `pnpm run test:e2e` runs Playwright.
2. **Add tests for new functionality.** Unit tests go in `tests/*.test.ts`. Browser-level tests go in `tests/e2e/`.
3. **Run the linter and type checker.** `pnpm run lint` (oxlint) and `pnpm run typecheck` (tsgo).
4. **Read `AGENTS.md`.** It has the architecture context, key gotchas, and development workflow that will save you (and your AI) time.

## AI code review

When you open a PR, tag one of our AI reviewers in a comment:

- **`/bonk`** — AI code review using Claude Opus 4.6
- **`/bigbonk`** — Same model, max thinking mode. Use this for complex or large PRs.

The reviewer will leave comments on your PR. You can respond to its comments and it will follow up.

## Debugging

For browser-level debugging (verifying rendered output, client-side navigation, hydration behavior), we recommend [agent-browser](https://github.com/vercel-labs/agent-browser). Unit tests miss a lot of subtle browser issues. agent-browser has been effective at catching them throughout this project.

## What to work on

Check the [open issues](https://github.com/cloudflare/vinext/issues). Issues labeled `post-launch` are known gaps we're planning to address. If you're looking to contribute, those are a good place to start.

## Project structure

See `AGENTS.md` for the full project structure, key files, architecture patterns, and development workflow.
