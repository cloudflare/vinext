# Autoresearch Ideas

## Bugs Found So Far

1. **Route handlers received plain Request instead of NextRequest** — `req.nextUrl` was undefined, causing 500 errors. Fixed by wrapping in `NextRequest` in app-rsc-entry.ts. (Iteration 5)
2. **Layout params scoping completely broken** — Every layout received ALL route params instead of scoped per-segment params. Root layout got `{param1, param2}` when it should get `{}`. Fixed `__scopeParamsForLayout` across 4 rendering loops + `buildPageElement`. (Iteration 12)

## Behavioral Differences Found

- **RSC redirect encoding**: Next.js returns 200 for RSC requests with redirect() — the redirect is encoded in the RSC stream so the client-side router handles it. Vinext returns 307 HTTP redirect for both document and RSC requests. The @vitejs/plugin-rsc client router handles this, but it's a behavioral difference that could affect client-side navigation patterns. (Found in rsc-redirect test, iteration 6)

## Process Improvements Made

- **Added cheerio + `fetchDom` helper** — Can now do DOM-level assertions in tests (querySelector, child count, text by ID). Unlocks porting tests that need DOM structure validation, not just string matching. (Iteration 12)
- **Separate fixtures are viable** — `startFixtureServer()` accepts any directory. Create new fixtures when the shared one doesn't work instead of skipping tests.

## Promising Directories to Port Next

- **`_allow-underscored-root-directory`** — Tests underscore convention. Could create a small dedicated fixture with `_handlers/` at app root.
- **`node-extensions`** — 50 HTTP-only tests! Tests `.mjs`, `.cjs`, `.js` extension handling in routes. Likely needs dedicated fixture.
- **Route handler tests**: Very productive for finding API surface gaps. Check more `app-routes-*` dirs.
- **Middleware tests**: `app-middleware`, `app-middleware-proxy` — could find middleware + route handler interaction bugs.
- **Actions tests**: `actions`, `actions-navigation` — server actions are core and likely have edge cases.
- **Dynamic data tests**: `dynamic-data`, `dynamic-requests` — test request-time API access patterns.
- **Redirect/rewrite tests**: `rewrites-redirects` has 2 HTTP-level tests among its 8.

## Directories Re-evaluate (Previously Skipped)

These were skipped as "needs custom fixture" but we should create fixtures for them:

- **`not-found-default`** — Needs custom root layout. Has HTTP test for 404 status on `/_not-found`.
- **`app-basepath`** — Needs basePath config. Has 4 HTTP tests.
- **`trailingslash`** — Needs trailingSlash config. Has 5 HTTP tests.
