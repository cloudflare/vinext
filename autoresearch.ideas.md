# Autoresearch Ideas

## Bugs Found So Far

1. **Route handlers received plain Request instead of NextRequest** — `req.nextUrl` was undefined, causing 500 errors. Fixed by wrapping in `NextRequest` in app-rsc-entry.ts. (Iteration 5)
2. **Layout params scoping completely broken** — Every layout received ALL route params instead of scoped per-segment params. Root layout got `{param1, param2}` when it should get `{}`. Fixed `__scopeParamsForLayout` across 4 rendering loops + `buildPageElement`. (Iteration 12)
3. **force-static pages leaked real `searchParams`** — `headers()` and `cookies()` were emptied, but `pageProps.searchParams` still received live query values. Fixed `buildPageElement()` to pass empty searchParams to force-static pages and metadata resolution. (Iteration 18)
4. **Default 404 pages were not wrapped in layouts** — when no explicit `not-found.tsx` existed, vinext returned a bare 404 instead of Next.js's default 404 UI wrapped in the root/ancestor layouts. Fixed `renderHTTPAccessFallbackPage()` to fall back to `next/error` for 404s and preserve layout wrapping. (Iteration 24)

## Behavioral Differences Found

- **RSC redirect encoding**: Next.js returns 200 for RSC requests with redirect() — the redirect is encoded in the RSC stream so the client-side router handles it. Vinext returns 307 HTTP redirect for both document and RSC requests. The @vitejs/plugin-rsc client router handles this, but it's a behavioral difference that could affect client-side navigation patterns. (Found in rsc-redirect test, iteration 6)

## Process Improvements Made

- **Added cheerio + `fetchDom` helper** — Can now do DOM-level assertions in tests (querySelector, child count, text by ID). Unlocks porting tests that need DOM structure validation, not just string matching. (Iteration 12)
- **Separate fixtures are viable** — `startFixtureServer()` accepts any directory. Create new fixtures when the shared one doesn't work instead of skipping tests.

## Promising Directories to Port Next

- **Redirect/rewrite tests**: `rewrites-redirects` has 2 pure-HTTP tests for exotic URL-scheme redirects.
- **Dynamic request API tests**: `dynamic-requests` may expose more request-scoped rendering bugs like the force-static searchParams issue.
- **Route handler tests**: Very productive for finding API surface gaps. Check more `app-routes-*` dirs.
- **Middleware tests**: `app-middleware`, `app-middleware-proxy` — could find middleware + route handler interaction bugs.
- **Actions tests**: `actions`, `actions-navigation` — server actions are core and likely have edge cases.

## Directories Re-evaluate (Previously Skipped)

These were skipped as "needs custom fixture" but we should create fixtures for them:

- **`not-found-default`** — Needs custom root layout. Has HTTP test for 404 status on `/_not-found`.
- **`trailingslash`** — Needs trailingSlash config. Has 5 HTTP tests.

## Bugs / follow-ups uncovered but not fixed yet

- **`app-basepath`: root `/base` 404s in dev** — Vite serves `basePath + "/"`, so `/base` gets a Vite 404 (`did you mean /base/?`) before vinext routing runs. Next.js serves `/base` correctly. Likely needs a pre-Vite normalization from exact `basePath` → `basePath + "/"` in dev.
- **Static metadata file routes are served but not injected into `<head>`** — `/manifest.webmanifest` and `/metadata/opengraph-image` work, but pages don't get `<link rel="manifest">` / `<meta property="og:image">` automatically from file conventions. This likely blocks `app-basepath` metadata tests and is broader than basePath itself.
- **`dynamic-requests` crashes on unreachable dynamic require/import patterns** — `vite-plugin-commonjs` rejects `require(value)` / `import(value)` even when they are in dead code paths that Next.js allows. This affects both pages and route handlers.
