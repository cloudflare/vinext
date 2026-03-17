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
