# pages-router-complex

A deliberately convoluted Pages Router app. It exists as a compatibility
target for vinext: the patterns here are the kind that only surface in big,
old, enterprise pages-router codebases. It is set up for Cloudflare the way
`vinext init` scaffolds it (vinext + cloudflare Vite plugins, KV data cache,
Workers CDN cache, Images optimizer, `wrangler.jsonc` with the
`vinext/server/fetch-handler` worker entry).

**It is expected to run correctly under real Next.js (`pnpm dev:next`).**
Running it under vinext (`pnpm dev`) is the goal, not (yet) the guarantee —
the e2e suite in `tests/e2e/pages-router-complex/` documents the target
behaviour and may fail under vinext today.

## The patterns being exercised

- **`pageExtensions: ["page.tsx", "page.ts"]`** — every routable file uses the
  suffix, non-page helpers live alongside pages (`pages/shell-initial-props.ts`),
  and `middleware.page.ts` / `instrumentation.page.ts` carry the suffix too.
- **App-shell `getInitialProps`** (disables automatic static optimisation) that
  fetches masthead/baseboard chrome through an in-memory TTL memoiser, skips
  the fetch entirely for embedded-shell (cookie-flagged) requests, bypasses the
  memo in draft mode, reads env-based settings, and emits a beacon when it
  re-runs client-side on navigations.
- **Extra named exports from special files**: `_app` re-exports a conditional
  top-level-await `outboundStub` promise; `middleware.page.ts` exports an
  unrelated async loader alongside `middleware` + `config`.
- **Class-based `_document`** with its own `getInitialProps` (palette derived
  from `ctx.req.url`, `<html lang>` from the zone), `beforeInteractive`
  scripts (external + `dangerouslySetInnerHTML` bootstrap), raw inline
  `<script>` tags, and data attributes on `<body>`.
- **Middleware pipeline** (regex `matcher` form): CDN-prefix rewrite
  (`/atlas/cdn/_next/*` → `/_next/*`), a 403 for `/_next/image`, a JSON
  `hardNavTo` response for raw `/_next/data` requests
  (`skipMiddlewareUrlNormalize`), editor-draft redirect on a request header,
  draft-cookie scrubbing for API routes via `NextResponse.next({ request })`,
  then a single-segment zone rewrite/redirect with an `x-zone` response
  header.
- **A `[zone]` route dimension** hidden from public URLs for the home zone,
  feeding a real **i18next/react-i18next** runtime (one instance per tree,
  synchronous init for SSR, per-zone bundles with fallback) and a zone-aware
  `next/link` wrapper for all chrome links.
- **Catch-all + siblings**: `gallery/[...facets]` with static siblings that
  must win precedence (`gallery/curated/first`, `gallery/directory/a-z`),
  facet-dedupe redirects, character-scrub redirects, permanent deep-trail
  collapses, cacheable 404s, and per-wall surrogate TTL overrides.
- **A dynamic/static/dynamic route sandwich** (`[collection]/item/[assetId]`)
  whose page-data function branches into three templates off what the
  catalogue record says the asset is (withdrawn records and malformed ids
  404 first).
- **`getServerSideProps` wrapped in a metering HOF** on every page, custom CDN
  cache headers (`Surrogate-Control`/`Surrogate-Key`), a conditional CSP
  response-header side effect, and one page with **no data-fetching function
  at all** (`detail-tools/client-flags`).
- **Server-snapshot data layer**: gSSP runs ops through a server handle that
  records a snapshot, the snapshot rides page props, and the browser handle
  is seeded with it so hydration reads from memory (`useGraphOp`).
- **Client-side routing machinery**: shallow `router.push` with the internal
  dynamic-route pattern as `pathname` and the public URL as `as`;
  `router.events` driving a transition overlay with a failsafe timeout; a
  router-agnostic reset hook on `next/compat/router` + `usePathname`.
- **App Router hooks in Pages Router pages**: `useSearchParams` seeding
  initial state and `usePathname`, combined with raw
  `window.history.replaceState` query updates that bypass the router.
- **`next/image` with a custom loader** in `fill` mode + css-module class on
  the fault screens — the framework optimizer endpoint is never used, which
  is what makes the middleware's `/_next/image` 403 safe.
- **API routes**: draft-mode gateway with landing-path resolution, a
  bearer-gated memo purge endpoint, a cookie-reflecting upstream relay proxy
  in promise-chain style, a legacy path rewritten in `afterFiles`, and a
  204-with-cache-headers type-ahead shim.
- **`next.config.js` (CJS)** exporting the **function form** — an async
  function of `(phase, context)` built by a decorator composer — with a
  throwing `generateBuildId`, prod-only `assetPrefix`, env-conditional
  `fallback` rewrites, and a webpack hook (workspace alias + test-module
  replacement via `NormalModuleReplacementPlugin`).
- **`instrumentation.page.ts`** gated on `NEXT_RUNTIME === "nodejs"`, with its
  effect observable through `/api/status`.

## Running

```bash
pnpm dev          # vinext dev server (needs RELEASE_TAG for now, see below)
pnpm dev:next     # real Next.js dev server (ground truth; --webpack, see below)
pnpm build        # vinext build (RELEASE_TAG is required and set inline)
pnpm build:next   # next build

# The behaviour suite (server starts under vinext automatically):
PLAYWRIGHT_PROJECT=pages-router-complex pnpm run test:e2e
```

## Known findings

- **Next.js 16.2.7 + Turbopack** fails to compile: the global-CSS-in-_app
  validation false-positives when `pageExtensions` renames `_app` to
  `_app.page.tsx`. The `dev:next`/`build:next` scripts pass `--webpack`.
- **TypeScript 7 (native preview)**: Next's own tsconfig-paths support
  degrades under it, so the `@atlas/*` alias is wired into both bundlers
  explicitly (webpack hook + Vite `resolve.alias`); tsconfig `paths` (without
  the removed `baseUrl`) stays authoritative for the type checker.
- **vinext dev (Cloudflare plugin): 59/73 specs pass; the 14 known gaps are
  marked `test.fixme` so the passing surface runs in CI.** Known gaps:
  `generateBuildId` is invoked at dev startup (Next.js only calls it at build
  time — the e2e server exports `RELEASE_TAG` to compensate), shallow routing
  + `router.events` (including a hydration knock-on that breaks page
  interactivity), the `next/image` custom-loader/`fill` path, raw
  `/_next/data` interception and the `/_next/image` 403 middleware branches,
  the `history.replaceState`-beside-the-router hybrid, the gallery scrub
  redirect, cacheable-404 surrogate headers, the `afterFiles` type-ahead
  rewrite, and the purge endpoint pair (possibly env vars not reaching the
  workerd runtime).
- The pinned workerd binary caps `compatibility_date` at 2026-04-08, so
  `wrangler.jsonc` pins 2026-04-01 rather than the scaffold's "today".

## Layout

- `lib/` — the app's internal platform libraries, consumed through tsconfig
  path aliases (`@atlas/*`) the way a monorepo app consumes shared packages:
  zones (zone routing + i18next runtime), edge-policy (CDN headers), memo
  (TTL result cache), beacon (metrics/RUM), graph-handle (data layer), chrome
  (masthead/baseboard), wiring + blocks (the provider pyramid and frame),
  trials, draft, and so on.
- `helpers/`, `surfaces/` — app-level page-data helpers and page templates.
- `pages/` — the route tree described above.
