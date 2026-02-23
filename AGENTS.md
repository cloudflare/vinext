# Agent Guidelines

Instructions for AI agents working on this codebase.

---

## Project Overview

**vinext** is a Vite plugin that reimplements the Next.js API surface, with Cloudflare Workers as the primary deployment target. The goal: take any Next.js app and deploy it to Workers with one command.

vinext reimplements the Next.js API surface using Vite, with Cloudflare Workers as the primary deployment target. The goal is to let developers keep their existing Next.js code and deploy it to Workers.

---

## Quick Reference

### Commands

```bash
pnpm test             # Vitest unit + integration tests
pnpm run test:e2e     # Playwright E2E tests (5 projects)
pnpm run typecheck    # TypeScript via tsgo (fast)
pnpm run lint         # oxlint
pnpm run build        # Build the vinext package
```

### Project Structure

```
packages/vinext/src/
  index.ts              # Main Vite plugin
  cli.ts                # vinext CLI
  shims/                # One file per next/* module
  routing/              # File-system route scanners
  server/               # SSR handlers, ISR, middleware
  cloudflare/           # KV cache handler

tests/
  *.test.ts             # Vitest tests
  fixtures/             # Test apps (pages-basic, app-basic, etc.)
  e2e/                  # Playwright tests

examples/               # User-facing demo apps
```

### Key Files

| File | Purpose |
|------|---------|
| `index.ts` | Vite plugin — resolves `next/*` imports, generates virtual modules |
| `shims/*.ts` | Reimplementations of `next/link`, `next/navigation`, etc. |
| `server/dev-server.ts` | Pages Router SSR handler |
| `server/app-dev-server.ts` | App Router RSC entry generator |
| `routing/pages-router.ts` | Scans `pages/` directory |
| `routing/app-router.ts` | Scans `app/` directory |

---

## Development Workflow

### Adding a New Feature

1. **Check if Next.js has it** — look at Next.js source to understand expected behavior
2. **Add tests first** — put test cases in the appropriate `tests/*.test.ts` file
3. **Implement in shims or server** — most features are either a shim (`next/*` module) or server-side logic
4. **Add fixture pages if needed** — `tests/fixtures/` has test apps for integration testing
5. **Run the full test suite** before committing

### Fixing Bugs

**Always check dev and prod server parity.** Request handling logic exists in multiple places that must stay in sync:

- `server/app-dev-server.ts` — App Router dev (generates the RSC entry)
- `server/dev-server.ts` — Pages Router dev
- `server/prod-server.ts` — Pages Router production (handles middleware, routing, SSR directly)
- `cloudflare/worker-entry.ts` — Cloudflare Workers entry

The App Router production server delegates to the built RSC entry, so it inherits fixes from `app-dev-server.ts`. But the Pages Router production server has its own middleware/routing/SSR logic that must be updated separately.

When fixing a bug in any of these files, check whether the same bug exists in the others. Do not leave known bugs as "follow-ups" — fix them in the same PR.

### Debugging

- **Dev server logs**: Run `npx vite dev` in a fixture directory
- **RSC streaming issues**: Context is often cleared before stream consumption — check AsyncLocalStorage usage
- **Module resolution**: Vite has separate module instances for RSC/SSR/client environments

### Test Fixtures

- `tests/fixtures/pages-basic/` — Pages Router test app
- `tests/fixtures/app-basic/` — App Router test app
- `examples/app-router-cloudflare/` — App Router on Workers
- `examples/pages-router-cloudflare/` — Pages Router on Workers

Add new test pages to fixtures, not to examples. Examples are for user-facing demos.

### Examples (Ecosystem Ports)

The `examples/` directory contains real-world Next.js apps ported to run on vinext. These are deployed to Cloudflare Workers on every push to main (see `.github/workflows/deploy-examples.yml`).

| Example | Type | URL |
|---------|------|-----|
| `app-router-cloudflare` | App Router basics | `app-router-cloudflare.vinext.workers.dev` |
| `pages-router-cloudflare` | Pages Router basics | `pages-router-cloudflare.vinext.workers.dev` |
| `app-router-playground` | Next.js playground (MDX, Tailwind) | `app-router-playground.vinext.workers.dev` |
| `realworld-api-rest` | RealWorld spec (Pages Router) | `realworld-api-rest.vinext.workers.dev` |
| `nextra-docs-template` | Nextra docs site (MDX, App Router) | `nextra-docs-template.vinext.workers.dev` |
| `benchmarks` | Performance benchmarks | `benchmarks.vinext.workers.dev` |
| `hackernews` | HN clone (App Router, RSC) | `hackernews.vinext.workers.dev` |

#### Adding a New Example

1. Create a directory under `examples/` with a `package.json` (use `"vinext": "workspace:*"`)
2. Add a `vite.config.ts` with `vinext()` and `cloudflare()` plugins
3. Add a `wrangler.jsonc` — for simple apps use `"main": "vinext/server/app-router-entry"` (no custom worker entry needed)
4. Add the example to the deploy matrix in `.github/workflows/deploy-examples.yml`:
   - Add to `matrix.example` array (with `name`, `project`, `wrangler_config`)
   - Add to the `examples` array in the PR comment step
5. Add a smoke test entry in `scripts/smoke-test.sh` — add a line to the `CHECKS` array:
   ```
   "your-example-name  /  expected-text-in-body"
   ```
6. Run `./scripts/smoke-test.sh` locally to verify after deploying

#### Smoke Tests

`scripts/smoke-test.sh` is a lightweight post-deploy check that curls every deployed example and verifies HTTP 200 + expected content. It runs automatically in CI after the deploy job completes.

```bash
./scripts/smoke-test.sh                    # check production URLs
./scripts/smoke-test.sh --preview pr-42    # check PR preview URLs
```

When adding a new example, always add a corresponding smoke test entry. The format is:
```
"worker-name  /path  expected-text"
```
where `expected-text` is a case-insensitive string that must appear in the response body.

#### Porting Strategy

The examples in `.github/repos.json` are the ecosystem of Next.js apps we want to support. When porting one:

1. **Use App Router** unless the original app specifically requires Pages Router
2. **Keep the same content** — the goal is to prove the app works on vinext, not to rewrite it
3. **Use `@mdx-js/rollup`** for MDX support (vinext auto-detects and injects it, or you can register it manually in `vite.config.ts`)
4. **File issues** for anything that requires workarounds — missing shims, unsupported config options, etc.
5. **Don't depend on the original framework's build plugins** — e.g., Nextra's webpack plugin won't work; port the content and build a lightweight equivalent

---

## Research Tools

### Context7 MCP

Context7 provides fast access to up-to-date documentation and source code for libraries. Use it liberally when researching how to implement something or debugging behavior.

**Key library IDs for this project:**
- `/vercel/next.js` — Next.js source code and docs
- `/llmstxt/nextjs_llms_txt` — Extended Next.js documentation
- `/vitejs/vite-plugin-react` — Vite RSC plugin docs

**Example queries:**
- How Next.js implements `headers()` and `cookies()` internally
- AsyncLocalStorage patterns for request-scoped context
- RSC streaming and rendering lifecycle
- Route matching and middleware patterns

### EXA Search

Use EXA for web search when you need to find recent discussions, blog posts, GitHub issues, or documentation that isn't in Context7. Particularly useful for:
- Finding workarounds for edge cases
- Understanding how other frameworks solved similar problems
- Locating relevant GitHub issues and discussions

### Looking at Next.js Source

**When in doubt, look at how Next.js does it.** Vinext aims to replicate Next.js behavior, so their implementation is the authoritative reference.

If you're trying to understand how something works under the hood — route matching, RSC streaming, caching behavior, API semantics — the best approach is to go look at the Next.js source code and understand what they're doing, then apply it to how we do things in this project.

---

## Git Workflow

- **NEVER push directly to main.** Always create a feature branch and open a PR, even for small fixes. This ensures CI runs before changes are merged and provides a review checkpoint.

- **Branch protection is enabled on main.** Required checks: Lint, Typecheck, Vitest, Playwright E2E. Pushing directly to main bypasses these protections and can introduce regressions.

- **NEVER use `gh pr merge --admin`.** The `--admin` flag bypasses branch protection checks entirely. If merge is blocked, investigate why — don't force it through. A blocked merge usually means a required check failed or is still running.

- **PR workflow:**
  1. Create a branch: `git checkout -b fix/descriptive-name`
  2. Make changes and commit
  3. Push branch: `git push -u origin fix/descriptive-name`
  4. Open PR via `gh pr create`
  5. Wait for CI to pass — all required checks (Lint, Typecheck, Vitest, Playwright E2E) must be green
  6. Merge via `gh pr merge --squash --delete-branch`
  7. If merge is blocked, check which status check failed and fix it — do not bypass with `--admin`

---

## Project Context

See `DISCOVERIES.md` for technical findings and architectural decisions discovered during development. That file documents non-obvious behaviors, gotchas, and implementation details that provide context for future work.
