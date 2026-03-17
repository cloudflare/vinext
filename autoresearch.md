# Autoresearch: Next.js Compat Test Suite Audit

## Objective

Systematically audit the Next.js test suite (`test/e2e/app-dir/`, 379 directories) and port relevant tests to vinext's `tests/nextjs-compat/` directory. Each iteration picks the next unaudited directory from the manifest, examines the Next.js test source, and either ports the tests (increasing coverage) or marks the directory as irrelevant.

The real value isn't just the test count — it's **discovering and fixing implementation bugs** along the way (like the `proxy-missing-export` silent fail-open bug from issue #203).

Reference: https://github.com/cloudflare/vinext/issues/204

## Metrics

- **Primary**: `passing_compat_tests` (count, higher is better) — number of passing test cases in `tests/nextjs-compat/`
- **Secondary**: `test_files` (count of test files), `dirs_covered` (directories with equivalent coverage), `skipped_tests` (tests marked skip)

## How to Run

`./autoresearch.sh` — runs `pnpm test tests/nextjs-compat/`, parses vitest output, outputs `METRIC name=number` lines.

## Iteration Protocol

Each iteration follows this exact sequence:

1. **Read manifest** — `autoresearch.manifest.json`. Find the next `"unaudited"` entry with lowest priority number (P1 = error/validation first).

2. **Read the Next.js test** — Use `gh api` or Context7 (`/vercel/next.js`) to read the test file in `test/e2e/app-dir/<dir>/`. Understand what behavior it validates.

3. **Classify relevance**:
   - `"covered"` — relevant and we will port tests
   - `"skip"` — not relevant to vinext (Turbopack-specific, Vercel-deploy-specific, build-tool-specific, requires browser-only Playwright, depends on unimplemented features we won't support)
   - `"partial"` — some tests are relevant, others aren't

4. **If skip**: Update manifest status to `"skip"` with a note explaining why. Log as `discard` (metric unchanged). Move to next directory.

5. **If relevant (covered/partial)**:
   a. Create fixture pages in `tests/fixtures/app-basic/app/nextjs-compat/<name>/`
   b. Write test file in `tests/nextjs-compat/<name>.test.ts` (follow existing patterns)
   c. Run tests — if they fail due to a vinext bug, **fix the bug in vinext source**
   d. Run `./autoresearch.sh` → log as `keep` if passing_compat_tests increased

6. **Update manifest** — set status and add notes about what was found.

## Files in Scope

### Test files (create/modify)

- `tests/nextjs-compat/*.test.ts` — ported compat tests
- `tests/fixtures/app-basic/app/nextjs-compat/*/` — fixture pages for tests

### Manifest and tracking

- `autoresearch.manifest.json` — work queue (status: unaudited/covered/skip/partial)
- `tests/nextjs-compat/TRACKING.md` — human-readable tracking document

### Vinext source (fix bugs found during porting)

- `packages/vinext/src/shims/*.ts` — Next.js module reimplementations
- `packages/vinext/src/server/dev-server.ts` — Pages Router SSR handler
- `packages/vinext/src/entries/app-rsc-entry.ts` — App Router RSC entry
- `packages/vinext/src/routing/*.ts` — File-system route scanners
- `packages/vinext/src/index.ts` — Main Vite plugin

## Off Limits

- `tests/*.test.ts` (non-compat tests) — read-only, don't modify
- `examples/` — don't touch
- `.github/` — don't touch
- Don't delete or modify existing passing tests in `tests/nextjs-compat/`

## Constraints

- **Existing tests must not break.** The checks script runs core tests after each iteration.
- **Follow the existing test pattern.** Use `startFixtureServer()`, `fetchHtml()`, same import style.
- **Include source links.** Every ported test must have a comment linking to the original Next.js test file.
- **One directory per iteration.** Keep iterations focused and revertable.
- **Fix bugs in the same iteration.** If porting a test exposes a vinext bug, fix it now — don't defer.
- **When a directory has many tests, port the most valuable subset** (error cases, validation) rather than trying to port everything in one iteration.

## Priority Order

1. **P1: Error handling and validation** (26 dirs) — most dangerous when missing
2. **P2: Edge cases for implemented features** (76 dirs) — catch-all, middleware, redirects, rewrites
3. **P3: Core features** (140 dirs) — RSC, routing, metadata, actions, caching
4. **P4: Other** (103 dirs) — less critical

## Test Pattern Reference

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vite-plus/test";
import type { ViteDevServer } from "vite-plus";
import { APP_FIXTURE_DIR, startFixtureServer, fetchHtml } from "../helpers.js";

describe("Next.js compat: <name>", () => {
  let server: ViteDevServer;
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, baseUrl } = await startFixtureServer(APP_FIXTURE_DIR, {
      appRouter: true,
    }));
    await fetchHtml(baseUrl, "/nextjs-compat/<warmup-path>");
  }, 60_000);

  afterAll(async () => {
    await server?.close();
  });

  // Source: https://github.com/vercel/next.js/blob/canary/test/e2e/app-dir/<dir>/<test-file>
  it("description matching Next.js test", async () => {
    const { html, res } = await fetchHtml(baseUrl, "/nextjs-compat/<path>");
    expect(res.status).toBe(200);
    expect(html).toContain("expected content");
  });
});
```

## What's Been Tried

_This section is updated as experiments accumulate._

### Baseline (iteration 0)

- 233 passing tests, 2 skipped, 21 test files
- Covers: app-rendering, not-found, global-error, dynamic, app-routes, metadata, navigation, rsc-basic, hooks, app-css, set-cookies, draft-mode, streaming, app-static (14 Next.js test dirs)

### Iteration 1: app-fetch-deduping-errors (+3 tests)

- Ported: page renders despite fetch error in generateMetadata and page component
- No bugs found

### Iteration 2-3: forbidden + unauthorized (+10 tests)

- Ported: scoped boundary, root escalation, 403/401 status codes
- Vinext already supports forbidden() and unauthorized() correctly

### Iteration 4: app-catch-all-optional (+3 tests)

- Ported: optional catch-all routing with/without rest params
- No bugs found

### Iteration 5: app-simple-routes (+2 tests) — **BUG FOUND + FIXED**

- **Bug**: Route handlers received plain `Request` instead of `NextRequest`. `req.nextUrl` was undefined, causing 500 errors.
- **Fix**: Wrapped `request` in `NextRequest` before passing to route handlers in `app-rsc-entry.ts` (same pattern already used for middleware).
- This is exactly the kind of bug issue #204 was designed to catch.

### P1 Triage Summary (26 dirs)

- All P1 (error/validation) directories audited
- Most are build-tool-specific (file patching + server restart) or Playwright-only
- Key skip reasons: Redbox assertions, next.cliOutput checks, client-side error boundary interactions

### Iteration 24: not-found-default (+3 tests) — **BUG FOUND + FIXED**

- Ported HTTP-testable subset with a dedicated fixture:
  - unmatched route renders default 404 inside root layout
  - `/_not-found` returns 404
  - grouped dynamic route falls back to default 404 inside group layout
- **Bug**: when no explicit `not-found.tsx` existed, vinext returned a bare default 404 instead of wrapping the default 404 UI in root/ancestor layouts like Next.js does.
- **Fix**: `renderHTTPAccessFallbackPage()` now falls back to `next/error` for 404s, preserving the normal layout wrapping path.

### Iteration 25: app-middleware (+11 tests) — **BUG FOUND + FIXED**

- Ported an HTTP-testable subset with a dedicated hybrid fixture:
  - middleware request-header mutation for `next/headers` pages + Pages API routes
  - draft mode cookie from middleware
  - `Link` response header preservation
  - `unstable_cache` inside middleware
  - plain `Location` response header is not treated as a rewrite
- **Bug**: middleware ran without a `next/headers` request context, so `headers()` inside middleware threw even though Next.js allows it.
- **Bug**: middleware `draftMode().enable()` lost its Set-Cookie header because the code read `getDraftModeCookieHeader()` after the ALS scope had already unwound.
- **Fix**: all middleware execution paths now run inside `runWithHeadersContext(..., phase="middleware")`, and draft-mode cookies are captured before the context exits.
- Snapshot expectations in `tests/entry-templates.test.ts` were updated because both generated middleware runtimes changed.

### Patterns Observed

- Many Next.js tests use `next.browser()` (Playwright) — not HTTP-testable with our pattern
- Tests using `next.render$` or `next.fetch` are portable
- Build-time validation tests (file patch + restart + CLI check) are a separate category we can't replicate
- Route handler tests are very productive — they often expose API surface gaps
