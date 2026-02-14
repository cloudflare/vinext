# Discovery Journal

Running log of non-obvious findings, gotchas, and architectural decisions made during development. Append new entries at the bottom of the relevant section (or add new sections as needed).

---

## Vite 7

- **SSR uses `ESModulesEvaluator`** which doesn't define `module`. React (CJS) must be externalized via `ssr.external: ["react", "react-dom", "react-dom/server"]`.
- **`appType: "custom"`** must be set to disable Vite's SPA fallback, otherwise Vite intercepts requests before our middleware.
- **`configFile: false`** is needed in programmatic test servers, otherwise Vite auto-loads the fixture's `vite.config.ts` causing duplicate plugin registration and config conflicts.
- **`transformIndexHtml`** extracts inline `<script type="module">` into proxy modules (`html-proxy`), which is fine for HMR but means client-side navigation cannot parse module URLs from HTML. Solution: embed module URLs in `__NEXT_DATA__.__vinext`.
- **Vite 7 rewrites `/` to `/index.html`** in post-middleware even with `appType: "custom"`. Our middleware normalizes `/index.html` back to `/` by checking `rawPathname.endsWith("/index.html")`.
- **Virtual modules in build**: Vite prefixes virtual module IDs with the root path when resolving SSR build entries. The `resolveId` hook must handle both `virtual:vinext-server-entry` and `<root>/virtual:vinext-server-entry`.
- **Virtual module imports must use absolute paths** since virtual modules have no real file location for relative path resolution.

## React SSR

- **`renderToString` inserts `<!-- -->` comment nodes** between text and expressions (e.g., `Post: <!-- -->42`). Tests must use regex matching to account for this.
- **JSX comments** (`{/* ... */}`) render as nothing in `renderToString` — they do NOT produce HTML comments. This caused the `NextScript` placeholder approach to silently fail. Fixed by using `dangerouslySetInnerHTML`.
- **`React.lazy` crashes in `renderToString`** (sync). Solution for `next/dynamic`: server-side `dynamic()` eagerly starts loading and registers in a `preloadQueue`. The SSR handler calls `flushPreloads()` (awaits all pending loads) before `renderToString`.

## Client-side Navigation

- **Browser back/forward requires a module-level `popstate` listener** — the `useRouter` hook's `useEffect` listener only exists while a component using `useRouter()` is mounted. We added a module-level `window.addEventListener("popstate", ...)` in the router shim.
- **Re-entrant `navigateClient` calls** caused issues — added `_navInProgress` guard flag.
- **Link `as` prop** — legacy Next.js pattern where `href="/user/[id]"` and `as="/user/1"`. Our Link shim uses `as` as the actual navigation href when provided.

## Dependency Quirks

- **`@unpic/react`** peer deps want React 17/18 but we use React 19. Need `--legacy-peer-deps` for npm install.
- **`@unpic/react`** uses discriminated union types for its Image component — `layout: "fullWidth"` and `layout: "constrained"` must be in separate JSX branches, not a ternary.

## Dev Server

- **Noisy Vite SSR errors for missing `_app`/`_document`** — fixed by pre-checking `fs.existsSync` with page extensions before calling `server.ssrLoadModule`.
- **Route scanning cache** — `pagesRouter()` and `apiRouter()` now cache results. File watcher on `add`/`unlink` events in pages directory calls `invalidateRouteCache()`.

## Tooling

- **tsgo** (`@typescript/native-preview`) is the Go-based TypeScript type checker. ~10x faster than tsc. Install with `npm install -D @typescript/native-preview`, run as `npx tsgo --noEmit`.
- **Plugin must be built to `dist/`** before running Playwright E2E tests or the realworld fixture, because the fixture's `vite.config.ts` imports from `vinext` which resolves to `dist/index.js`.

## Phase 2: @vitejs/plugin-rsc (Research)

- **`@vitejs/plugin-rsc`** (v0.5.19) is the official Vite RSC plugin. Handles bundler transforms (`"use client"` / `"use server"`), RSC stream serialization (wraps `react-server-dom-webpack`), multi-environment builds (RSC/SSR/Client), CSS code-splitting, and HMR.
- **It does NOT handle** routing, request lifecycle, layout nesting, or navigation — those are the framework's (our) responsibility.
- Key sub-path exports: `@vitejs/plugin-rsc/rsc` (renderToReadableStream), `@vitejs/plugin-rsc/ssr` (createFromReadableStream), `@vitejs/plugin-rsc/browser` (createFromReadableStream, createFromFetch, encodeReply, setServerCallback).
- Uses `import.meta.viteRsc.loadModule()` for cross-environment communication.
- Uses `rsc-html-stream` package for injecting RSC payload into HTML.
- We initially planned `serverHandler: false` to own the request lifecycle, but the **default behavior is better for dev**: the plugin-rsc sets up its own middleware calling the RSC entry's `default` export. This means we do NOT need custom middleware for app routes in dev mode — the plugin handles request routing automatically.
- **Our RSC entry's `default` export** is the request handler. Plugin-rsc calls it for every request and our code does route matching, builds the React tree (layouts + page), renders to RSC stream, and delegates to the SSR entry for HTML.
- **CSS is auto-injected** by plugin-rsc's `rscCssTransform` — no manual `loadCss()` calls needed for server components.
- **Virtual module IDs for entries**: We pass `entries: { rsc: "virtual:vinext-rsc-entry", ssr: "virtual:vinext-app-ssr-entry", client: "virtual:vinext-app-browser-entry" }` to the RSC plugin, and our `resolveId`/`load` hooks serve the generated code. Works seamlessly.
- **RSC stream format**: The `.rsc` endpoint returns `text/x-component` content type. The stream contains serialized React elements with client references, metadata like file paths, and component definitions.
- **Bootstrap script injection**: Plugin-rsc auto-injects `<script id="_R_">import("/@id/...")` into HTML for client hydration. No manual script tag needed.
- **Shim imports in generated code**: The RSC entry imports `next/navigation` and `next/headers` which resolve through Vite aliases to our shim files. Internal setter functions (`setNavigationContext`, `setHeadersContext`) are exported from the shims and called by the generated entry code.
- **Virtual module caching**: Vite caches virtual module results from `load()` hooks. When running the fixture dev server (which uses the built plugin from `dist/`), changes to the generator TypeScript source require a `tsc` rebuild before taking effect. The `vitest` tests use the source TS directly and always pick up changes.
- **error.tsx must be `"use client"`**: In the RSC model, ErrorBoundary is a class component using `getDerivedStateFromError` which is client-only. We created a generic `ErrorBoundary` component in `shims/error-boundary.tsx` that wraps the user's error.tsx component. It's imported in the RSC entry and the RSC bundler handles the client reference.
- **not-found.tsx handling**: Route-level not-found works per-segment, but global 404 (no route match) needs to reference the root not-found module directly. We resolve the root route's `notFoundPath` at code-generation time and emit `rootNotFoundModule` as a top-level variable, avoiding the need to search routes at runtime.
- **Virtual module `\0` prefix in client environment**: When `@vitejs/plugin-rsc` generates its `virtual:vite-rsc/entry-browser` module, it imports our virtual entry using the already-resolved `\0`-prefixed ID (e.g., `\0virtual:vinext-app-browser-entry`). Vite's `import-analysis` plugin in the client environment fails to resolve this. Fix: `resolveId` must strip the `\0` prefix before matching, e.g., `const cleanId = id.startsWith("\0") ? id.slice(1) : id`.
- **Server Actions transport**: `@vitejs/plugin-rsc` is transport-agnostic for server actions. It provides serialization primitives (`encodeReply`/`decodeReply`/`loadServerAction`) but we must implement the HTTP transport. Convention: POST to `pathname.rsc` with `x-rsc-action: <actionId>` header. The RSC entry must `decodeReply` the body, `loadServerAction(id)`, execute it, then re-render the page tree and include `returnValue` in the RSC stream payload. The browser uses `setServerCallback` to register the action handler.
- **RSC action response shape**: When server actions complete, the RSC stream must serialize `{ root: <pageElement>, returnValue: { ok: true, data } }`. The browser deserializes this, renders `result.root` and returns `result.returnValue.data` to the caller. This allows the page to reflect mutations while the action return value is delivered to the calling component's state.

## Middleware

- **middleware.ts runs in Node**, not Edge Runtime. This is a deliberate departure from Next.js (which uses Edge Runtime). Since vinext targets "deploy anywhere" including $5 VPS, Node is the pragmatic choice. The middleware uses standard Web APIs (`Request`/`Response`/`NextRequest`/`NextResponse`) so the API surface is compatible.
- **Middleware detection**: We check for `middleware.ts/.tsx/.js/.mjs` at the project root and also in `src/` subdirectory (Next.js convention).
- **Two integration paths**: Pages Router uses Vite's `server.ssrLoadModule()` in the connect middleware. App Router imports the middleware module directly in the generated RSC entry (since the RSC entry runs in its own Vite environment where `ssrLoadModule` isn't available).
- **Matcher patterns**: Next.js matcher uses a custom path pattern syntax that's similar to but not identical to regex. Patterns like `/((?!api|_next).*)` are common. We convert these to proper RegExp for matching.

## Caching

- **Next.js CacheHandler interface has churned significantly** across versions 13-16. The `kind` enum values changed (`PAGE` → `PAGES`, `ROUTE` → `APP_ROUTE`), the set context shape changed from `{ revalidate }` to `{ cacheControl: { revalidate, expire } }`, and `revalidateTag` went from `(tag: string)` to `(tags: string | string[], durations?)`.
- **Our CacheHandler interface targets Next.js 16** but accepts both old and new context shapes in `MemoryCacheHandler.set()` for compatibility with community adapters.
- **Tag invalidation timing**: When using `>=` (not `>`) for comparing `revalidatedAt` vs `lastModified`, entries invalidated in the same millisecond they were created are correctly evicted. This matters in fast test environments.

## Streaming SSR

- **Pages Router now uses `renderToPipeableStream`** instead of `renderToString`. This enables Suspense support — `React.lazy` components resolve before the stream completes, and Suspense boundaries are handled correctly.
- **`onAllReady` vs `onShellReady`**: We use `onAllReady` (waits for all Suspense boundaries to resolve) rather than `onShellReady` (starts streaming after initial shell). This is because the Pages Router needs the complete HTML string for `transformIndexHtml` (dev) and head tag injection. True progressive streaming (using `onShellReady`) would require rearchitecting how `<Head>` tags and `__NEXT_DATA__` are injected.
- **App Router already streams**: The App Router SSR entry uses `renderToReadableStream` from `react-dom/server.edge` through `@vitejs/plugin-rsc`. No changes were needed there.
- **`createBuilder` API is required for RSC production builds**: Calling `build()` directly from the Vite JS API doesn't trigger the RSC plugin's multi-environment build pipeline. Must use `createBuilder()` + `builder.buildApp()` instead, which runs the 5-step RSC/SSR/client build sequence.
- **`renderToPipeableStream` auto-prepends `<!DOCTYPE html>`** when the root element is `<html>`. The old `renderToString` did NOT do this. After switching to streaming, we had a double `<!DOCTYPE html>` bug in `_document` rendering. Fixed by removing the manual `"<!DOCTYPE html>" +` prefix.

## Static Export (`output: 'export'`)

- **App Router static export is simplest as fetch-from-dev-server**: Rather than reimplementing the RSC→SSR→HTML pipeline, we start a dev server and fetch each route via HTTP. This reuses the full rendering pipeline including layouts, metadata, error boundaries, etc.
- **Pages Router static export uses direct rendering**: Since we have `renderToStringAsync` and the full page rendering infrastructure in the static export module, we render directly without needing a running server.
- **`generateStaticParams` must return all paths**: With `output: 'export'`, there's no server to handle fallback rendering. Dynamic routes without `generateStaticParams` are build errors.
- **`getStaticPaths` must use `fallback: false`**: Same reason — no server for fallback rendering.
- **404 page for App Router**: We fetch a nonexistent URL from the dev server and save the 404 response as `404.html`.

## Metadata Routes (sitemap.xml, robots.txt, manifest.webmanifest)

- **Handled as special routes in the RSC entry**, checked before normal page routing. Dynamic versions (`.ts`) call the default export and serialize to the appropriate format; static versions are served directly from disk.
- **Next.js metadata route convention**: Files named `sitemap.ts`, `robots.ts`, `manifest.ts` (or `.js`) in `app/` export a default function returning structured data. Static variants (`.xml`, `.txt`, `.webmanifest`) are served as-is.
- **Serialization is format-specific**: `sitemapToXml()` produces XML with `<urlset>` and `<url>` elements, `robotsToText()` produces `User-Agent:`/`Allow:`/`Disallow:`/`Sitemap:` lines, `manifestToJson()` outputs a Web App Manifest JSON.
- **`scanMetadataFiles()`** scans the `app/` directory root for metadata files and returns typed `MetadataFileRoute[]` with `type`, `servedUrl`, `isDynamic`, and `filePath` fields.
- **Both static and dynamic metadata routes share the same route table** in the generated RSC entry. Static routes read from disk at request time; dynamic routes import the module and call the default export.
- **React 19 auto-hoisting** means metadata rendered via `<MetadataHead>` anywhere in the tree gets moved to `<head>` automatically — no special placement needed.

## ISR (Incremental Static Regeneration)

- **Stale-while-revalidate requires returning stale cache entries, not null**. The original `MemoryCacheHandler.get()` deleted expired entries and returned null. ISR needs the stale entry to serve while background regeneration runs. Fixed by returning entries with `cacheState: "stale"` on expiry, while tag-invalidated entries are still hard-deleted (return null).
- **Background regeneration dedup is essential**. Without it, 100 concurrent requests to a stale page would trigger 100 re-renders. A `Map<string, Promise>` keyed by cache key ensures only one regeneration per key at a time.
- **ISR cache layer sits above CacheHandler**, not inside it. The `CacheHandler` interface is a dumb key-value store (matching Next.js 16's interface). ISR semantics (stale detection, background regen, dedup) live in a separate `isr-cache.ts` module. This preserves pluggable backends — Redis/KV users get ISR automatically.
- **Revalidate duration tracking**: Cache hits need the original revalidate seconds for `Cache-Control` headers, but the `CacheHandler` interface doesn't expose this. Solution: a side `Map<string, number>` stores revalidate durations by cache key, populated on MISS, read on HIT/STALE.
- **Pages Router ISR**: `getStaticProps` returns `{ revalidate: N }`. On MISS, render + cache. On HIT, serve cached HTML. On STALE, serve cached HTML + trigger background `getStaticProps` re-call.
- **App Router ISR**: `export const revalidate = N` in page modules. Read at runtime from `route.page.revalidate` in the generated RSC handler. The RSC stream output is tee'd — one copy for the response, one consumed for caching.
- **`Cache-Control: s-maxage=N, stale-while-revalidate`** is set on all ISR responses (MISS/HIT/STALE). This enables CDN-level caching that mirrors server-side ISR behavior. CDNs like Cloudflare respect these headers natively.
- **`X-Nextcompat-Cache: HIT|STALE|MISS`** header for observability — makes it easy to debug ISR behavior in browser DevTools or monitoring.

## Parallel Routes

- **`@slot` directories are invisible in URLs** — they are stripped from URL patterns the same way route groups `(group)` are. Slot pages (`@team/page.tsx`) don't create standalone routes.
- **Parallel slots are props to the layout**, not separate routes. The innermost layout at the route directory level receives slot content as named props (e.g., `team`, `analytics`) alongside `children`.
- **Slots need at least a `page.tsx` or `default.tsx`** to be discovered. A `default.tsx` provides fallback content when the slot shouldn't render anything (e.g., no modal active).
- **Each slot can have its own `loading.tsx` and `error.tsx`**, wrapped independently with `Suspense` and `ErrorBoundary`.

## Intercepting Routes

- **Interception conventions**: `(.)` (same level), `(..)` (one level up), `(..)(..)` (two levels up), `(...)` (from root). These are directory name prefixes inside `@slot` directories.
- **Intercepting routes only activate on client-side navigation** (RSC requests), not on direct/hard navigation (SSR). On SSR, the target route renders normally and the slot shows `default.tsx`.
- **`(...)photos/[id]` from `app/feed/@modal/`** intercepts `/photos/:id` (resolves from app root). This is different from `(.)photos/[id]` which would resolve to `/feed/photos/:id` (same level as the route).
- **The source route is rendered with the intercepting page in the slot**, not the target route. e.g., navigating from `/feed` to `/photos/42` renders the `/feed` layout with `@modal` showing the photo modal, not the `/photos/42` page.
- **RSC payload contains both the source route content and the intercepted slot content**, so the client can render the feed page with the modal overlay in a single stream.

## i18n Routing

- **i18n is a Pages Router feature only** in Next.js 16+. The App Router dropped built-in i18n — apps are expected to use middleware for locale routing. We implement i18n for Pages Router only.
- **Locale prefix stripping** happens before route matching. `/fr/about` strips to `/about` with `locale: "fr"`. The default locale has no prefix (`/about` → `locale: "en"`).
- **Accept-Language detection** triggers a 307 redirect to the detected locale prefix on first visit (when `localeDetection: true`). This only fires if no locale prefix was in the URL.
- **`getServerSideProps`/`getStaticProps`/`getStaticPaths`** all receive `locale`, `locales`, and `defaultLocale` in their context objects, matching Next.js behavior.
- **`useRouter().locale`** is populated from SSR context on the server, and from `window.__NEXTCOMPAT_LOCALE__` on the client. The i18n globals are injected alongside `__NEXT_DATA__`.

## Parallel Route Slot Inheritance

- **Parallel slots must be inherited by child routes.** When `/dashboard/settings` is rendered, the dashboard layout's `@team` and `@analytics` slots need to render even though `settings/` has no `@slot` dirs. The fix: `discoverInheritedParallelSlots` walks from the app root through each segment, collecting slots. Ancestor slots use `default.tsx` as the active page, not `page.tsx`.
- **Each slot tracks `layoutIndex`** — the index in `route.layouts[]` of the layout it belongs to. This ensures slots are passed as props to the correct layout (the one that defines them), not blindly to the innermost layout.
- **Slot directories at the route's own level** use `page.tsx` as normal. Slot directories at ancestor levels use `default.tsx` (the fallback). This matches Next.js semantics exactly.

## basePath / trailingSlash

- **basePath stripping** must happen early in the request pipeline, before middleware, headers, redirects, and rewrites. Both Pages Router (connect middleware in `index.ts`) and App Router (generated RSC entry handler) strip basePath before route matching.
- **`process.env.__NEXT_ROUTER_BASEPATH`** is injected as a Vite define so client-side code (Link, router shims, navigation shims) can prepend/strip basePath without runtime config.
- **`usePathname()` returns paths WITHOUT basePath**, matching Next.js behavior. Browser `window.location.pathname` includes it, so client code must strip.
- **trailingSlash normalization** uses 308 redirects (not 301/302) — permanent redirect preserving the HTTP method. API routes (`/api/*`) and `.rsc` requests are excluded.

## Route Segment Config

- **`export const revalidate`** was already wired — the RSC entry reads `route.page?.revalidate` from the module exports. Adding a fixture and test confirmed it works.
- **`export const dynamicParams = false`** checks params against `generateStaticParams()` results at request time. If the current params aren't in the static list, return 404. This runs before ISR/caching.
- **`export const dynamic = "force-dynamic"`** was already implemented. Sets `Cache-Control: no-store, must-revalidate` and skips ISR cache.

## Viewport Metadata

- **`export const viewport`** and `generateViewport()` are separate from the metadata export in Next.js. They control viewport-related meta tags (`<meta name="viewport">`, `<meta name="theme-color">`, `<meta name="color-scheme">`). We resolve them alongside metadata from layouts and pages, merging with later entries overriding earlier ones.

## ESM Build Issues

- **`require()` is not available** in ESM builds. `scanMetadataFiles` was using `require("node:fs")` which worked in Vitest (CJS transform) but failed when the plugin was built to `dist/` and loaded by the Playwright fixture. Fixed by using standard `import` at the top of the file.

## RSC Environment + Native Modules

- **Native Node modules (satori, @resvg/resvg-js) crash Vite's RSC dev environment.** Even with `resolve.external` configured on the RSC environment, the module runner's `ESModulesEvaluator` cannot handle native addons properly in dev mode. The socket closes on the server side with no response. Adding `resolve.external: ["satori", "@resvg/resvg-js", "yoga-wasm-web"]` to the RSC environment config is the right direction, but Vite 7's environment-level externalization may not be fully working for the RSC runner yet. This is a Vite limitation, not a vinext bug. **Workaround**: dynamic icon.tsx/opengraph-image.tsx routes work in production builds (where everything is bundled by Rollup) but may fail in dev. Static .png/.svg icon files work in both modes.

## Route Segment Config: force-static

- **`export const dynamic = "force-static"`** treats the page as fully static. Headers/cookies contexts are replaced with empty values (empty `Headers()`, empty cookie `Map`), and searchParams are cleared to `new URLSearchParams()`. Response gets `Cache-Control: s-maxage=31536000, stale-while-revalidate` and `X-Nextcompat-Cache: STATIC`. If combined with `export const revalidate`, ISR still applies (the cache TTL comes from revalidate, not the 1-year default).

## Route Segment Config: No-ops

- **`fetchCache`, `maxDuration`, `preferredRegion`, `runtime`** are recognized but no-op in vinext. `fetchCache` controls Next.js's patched `fetch()` caching (not applicable — we don't patch fetch). `maxDuration` sets serverless function timeout (platform-specific). `preferredRegion` hints deployment region. `runtime` selects Edge/Node runtime. Pages with these exports render normally without errors.

## redirect()/notFound() in Server Components

- **RSC `renderToReadableStream` strips error `digest` property.** When `redirect()` or `notFound()` throws an Error with a `digest` property, the RSC serialization layer (`@vitejs/plugin-rsc`) removes it — the SSR layer receives `digest: ''`. Fix: **pre-render the page component** by calling `PageComponent({ params })` before starting RSC rendering. Since Server Components are just functions, synchronous `redirect()`/`notFound()` throws are caught immediately. Async components are awaited. This intercepts the special errors before RSC streaming begins and returns proper HTTP responses (307/308 redirect, 404).

## draftMode

- **`draftMode()` uses `__prerender_bypass` cookie** (matching Next.js convention). `enable()` sets the cookie via a `Set-Cookie` header on the response. `disable()` clears it with `Max-Age=0`. The generated RSC entry calls `getDraftModeCookieHeader()` after rendering to attach the header. `isEnabled` reads from the request cookie context.

## dynamic = "error"

- **`dynamic = "error"` uses Proxy-based traps** on the headers/cookies context. When a page with `dynamic = "error"` tries to access `headers()`, `cookies()`, or `searchParams`, the Proxy throws an informative error. SearchParams are also cleared. Response gets the same caching headers as `force-static` (s-maxage=31536000).

## Route handlers

- **HEAD auto-implementation**: When a route exports `GET` but not `HEAD`, Next.js automatically handles HEAD by running GET and stripping the body. Our handler does the same.
- **OPTIONS auto-implementation**: Next.js returns 204 with `Allow` header listing all exported methods. `HEAD` is implicitly included when `GET` exists.
- **Vite CORS middleware intercepts OPTIONS**: In dev mode, Vite's built-in CORS middleware responds to OPTIONS requests before our handler. Set `server.cors: false` in test configuration to test OPTIONS handling directly.
- **Route handler params**: Route handler functions receive `(request, { params })` as second argument. Dynamic route segments are passed as `params`.
- **Route handler error body should be empty**: Next.js returns 500 with empty body for route handler errors, not "Internal Server Error" text.
- **Route handler redirect/notFound**: `redirect()` and `notFound()` thrown from route handlers return HTTP responses (307 redirect / 404 with empty body).

## Navigation

- **Hash-only navigation must skip RSC fetch**: Clicking `<Link href="#foo">` or calling `router.push("#hash")` should NOT trigger an RSC round-trip. Only update the URL and scroll to the target element.
- **Relative hrefs resolve against current URL**: `<Link href="#h1">`, `<Link href="?foo=1">` resolve relative to `window.location.href`.
- **External URLs in router.push()**: `router.push("https://...")` must use `window.location.assign()`, not `history.pushState()`.
- **Scroll restoration**: Save scroll position (`scrollX`, `scrollY`) in `history.state` before every push navigation. On `popstate`, restore from `event.state`.
- **scrollToHash**: After navigation to a URL with a hash, scroll to the element with matching `id` using `element.scrollIntoView()`.

## Metadata

- **Title templates apply to child segments only**: `title.template` in `layout.js` does NOT apply to the `page.js` in the same route segment. Only child segments' titles get wrapped.
- **`title.absolute` skips all templates**: Useful for overriding the parent template entirely.
- **`metadataBase` for URL resolution**: Base URL for composing relative URLs in metadata (canonical, OG images, alternates). Use `new URL(relative, metadataBase)` for composition.
- **`noindex` meta auto-injected on 404 pages**: Next.js automatically adds `<meta name="robots" content="noindex"/>` when rendering not-found pages.
- **`notFound()` must propagate past error boundaries**: `getDerivedStateFromError` in the `ErrorBoundary` shim must re-throw errors with `digest === "NEXT_NOT_FOUND"` or `"NEXT_REDIRECT;..."`. These are framework-level errors, not component errors.

## Static Metadata Images

- **Static image files in route directories** (`icon.png`, `opengraph-image.png`, `twitter-image.png`, `apple-icon.png`) are served with their file extension's content type and `Cache-Control: public, max-age=0, must-revalidate`.
- **Dynamic takes priority over static**: If both `icon.tsx` (dynamic) and `icon.png` (static) exist at the same level, the dynamic version takes priority. Deduplication in `scanMetadataFiles()` uses `servedUrl` as key.
- **Nestable image metadata**: `icon`, `opengraph-image`, `twitter-image`, `apple-icon` can appear in sub-route directories (e.g., `app/about/opengraph-image.png` → `/about/opengraph-image`). `favicon`, `robots`, `manifest` are root-only.

## notFound() Escalation

- **`notFound()` finds the nearest ancestor `not-found.tsx`**: When thrown from `/dashboard/settings/page.tsx`, the framework walks from the route directory up to the app root looking for `not-found.tsx`. The first (closest) one found is used. If none found, falls back to root `not-found.tsx`.
- **Layout wrapping for non-root not-found**: When `dashboard/not-found.tsx` is used, it's still wrapped in all layouts from root to the dashboard level (root layout + dashboard layout), matching Next.js behavior.

## useParams Referential Stability

- **`setClientParams` JSON comparison**: Uses `JSON.stringify()` to compare new params with previous. Only creates a new object reference when the JSON differs. This prevents unnecessary re-renders in components that depend on params identity.

## isHashOnlyChange Fix

- **`#hash` prefix should bypass `window` check**: The original `isHashOnlyChange` checked `typeof window === "undefined"` before `href.startsWith("#")`. This caused `#section` to return `false` on the server. Fix: check `startsWith("#")` FIRST, before the window guard. `#foo` is always a hash-only change regardless of environment.

## API Surface Gaps

- **`next/legacy/image`** is critical for Next.js 12 migrations. Apps that ran the `next-image-to-legacy-image` codemod import from this module. It uses `layout` prop (`"fill"|"responsive"|"intrinsic"|"fixed"`) instead of the modern `fill` boolean.
- **`next/legacy/image` imports `next/image` internally**: In Vitest (outside Vite's alias system), `import Image from "next/image"` fails. Fix: use relative import (`./image.js`) instead of the aliased bare specifier.
- **`NextRequest.ip`** extracts from `x-forwarded-for` header (first entry, comma-separated).
- **`NextRequest.geo`** extracts from Cloudflare (`cf-ipcountry`, `cf-ipcity`, etc.) or Vercel (`x-vercel-ip-country`, etc.) headers. Returns `undefined` if no geo headers present.
- **`getImageProps`** (Next.js 14+) returns the underlying `<img>` props without rendering. Used for `<picture>` elements and CSS background images.
- **`ReadonlyURLSearchParams`** is just a type alias for `URLSearchParams` — Next.js uses it to signal read-only intent but doesn't enforce at runtime.
- **`useServerInsertedHTML`** from `next/navigation` is used by styled-components/emotion for SSR style injection. In our implementation, this is a no-op since Vite handles CSS.

## HTTP Access Fallback (forbidden/unauthorized)

- **Unified error digest format**: Next.js 16 uses `NEXT_HTTP_ERROR_FALLBACK;{statusCode}` as the digest prefix for `notFound()` (404), `forbidden()` (403), and `unauthorized()` (401). The old `NEXT_NOT_FOUND` digest is legacy. Our implementation supports both formats for backward compatibility.
- **`forbidden()` and `unauthorized()` are experimental** in Next.js 16, gated behind `experimental.authInterrupts` config. We support them unconditionally — simpler and more useful.
- **Boundary file conventions**: `forbidden.tsx` and `unauthorized.tsx` work identically to `not-found.tsx` — discovered by walking from route directory up to app root (nearest wins), wrapped in layouts, with `<meta name="robots" content="noindex">` injected.
- **Error boundary propagation**: The `ErrorBoundary` (error.tsx wrapper) must re-throw errors with `NEXT_HTTP_ERROR_FALLBACK;*` digests, not just `NEXT_NOT_FOUND`. Updated to check `digest.startsWith("NEXT_HTTP_ERROR_FALLBACK;")`.

## Cache APIs

- **`cacheLife()` and `cacheTag()` require `"use cache"` directive** in Next.js — they only work inside functions marked with `"use cache"`. Since we don't support the `"use cache"` directive yet (it's a compiler feature), these are exported as validation-only no-ops.
- **Built-in cache profiles**: `default` (15min revalidate), `seconds` (1s), `minutes` (1min), `hours` (1hr), `days` (1day), `weeks` (1week), `max` (1month). Values match Next.js 16 `config-shared.ts`.
- **`cacheLife` minimum-wins**: If called multiple times in a `"use cache"` function, the lowest value wins for each field. Important for nested caches.

## generateStaticParams

- **Parent params passing is top-down**: For nested dynamic routes like `/[category]/[item]`, the parent's `generateStaticParams` runs first, then each result is passed to the child as `{ params: { category } }`.
- **Static export uses full top-down resolution**: `resolveParentParams()` walks ancestor routes, finds those with `generateStaticParams`, runs them top-down, and merges results. The child is called once per parent param combination.
- **Dev server `dynamicParams` check passes full URL params**: When `dynamicParams: false` validates against `generateStaticParams`, we pass the full matched URL params. The child's returned param sets may omit parent params (they're inherited), so the validation skips undefined keys.

## URLPattern

- **URLPattern is a Web API** available natively in Node 20+, Cloudflare Workers, and Deno. Next.js re-exports it from `next/server` for middleware route matching. Our export uses `globalThis.URLPattern` with a fallback that throws a helpful error.

## Extended fetch() caching

- **`globalThis.fetch` is patched per-request**, not globally at startup. `withFetchCache()` installs a patched fetch and returns a cleanup function — this ensures no cross-request state leakage and works correctly with concurrent requests (each request gets its own patched fetch scope).
- **Cache key = `fetch:{METHOD}:{URL}` + optional body hash.** Headers are intentionally excluded from the key — Next.js data cache keys by URL, not by request headers. This matches Next.js behavior where `Authorization` headers don't affect cache keys (the expectation is that auth-dependent data uses `cache: 'no-store'`).
- **`next: { tags }` without `revalidate` implies `force-cache`** — if you specify tags, Next.js assumes you want caching (so `revalidateTag()` has something to invalidate). We use a 1-year TTL for this case.
- **`next: { revalidate: 0 }` is equivalent to `cache: 'no-store'`** — zero seconds means "never cache". This matches Next.js behavior where `revalidate: 0` opts out of the data cache entirely.
- **Stale-while-revalidate for fetch**: When a cached fetch entry is stale (past TTL), we return the stale data immediately and trigger a background refetch. This mirrors the page-level ISR SWR pattern but at the individual fetch level.
- **The `next` property must be stripped from `init` before passing to real fetch.** Standard `fetch()` implementations may warn or error on unknown properties. We use a spread-and-delete pattern to clean the init object.

## history.pushState/replaceState interception

- **Shallow routing requires history method patching.** Next.js intercepts `window.history.pushState()` and `window.history.replaceState()` so that when user code updates the URL directly (common for filter UIs, tabs, URL search param state), React hooks like `usePathname()` and `useSearchParams()` re-render with the new URL values.
- **Internal operations must use the original `replaceState`.** `saveScrollPosition()` calls `history.replaceState()` to store scroll coordinates in history state — this must NOT trigger `notifyListeners()` or it would cause spurious re-renders. Solution: capture a reference to the native `replaceState` before patching and use that for internal operations.
- **Double notification is harmless but avoidable.** Our `navigateImpl()` already calls `notifyListeners()` after `pushState/replaceState`, and the patched methods also call it. `useSyncExternalStore` deduplicates by comparing snapshots, so this is safe. We leave both calls for robustness.

## instrumentation.ts

- **`instrumentation.ts` is loaded once at server startup**, not per-request. The `register()` function is called during `configureServer()` (Vite plugin hook), before any request handling begins. This is the recommended place to initialize Sentry, Datadog, OpenTelemetry, etc.
- **`onRequestError()` is stored module-level** and called from error handlers in both Pages Router (`dev-server.ts`) and App Router (`app-dev-server.ts`). The context includes `routerKind`, `routePath`, and `routeType` (render/route/action/middleware).
- **File detection mirrors middleware pattern**: Checks `instrumentation.{ts,tsx,js,mjs}` at root and in `src/`. Same convention as Next.js.

## Link/Router prefetching

- **IntersectionObserver with 250px rootMargin**: Links prefetch when they're within 250px of the viewport edge, giving the browser a head start. All Link components share a single observer instance to minimize resource usage.
- **RSC prefetch uses `priority: "low"`** to avoid competing with critical requests. The `.rsc` payload is fetched in the background via `requestIdleCallback`.
- **Pages Router prefetch injects `<link rel="prefetch">`** rather than pre-importing the module — this lets the browser's preload scanner handle it at the optimal time.
- **Prefetch dedup via `Set<string>`**: Each URL is only prefetched once per page load. The set is not shared across page navigations (it resets on full page load).

## next/font className

- **Next.js generates CSS rules at build time** mapping each font's `className` to its `font-family`. Our runtime shim must do the same — without the CSS rule, `<div className={inter.className}>` has no effect.
- **CSS variable injection**: When `variable` is specified (e.g., `variable: "--font-inter"`), a CSS rule like `.className { --font-inter: 'Inter', sans-serif; }` is generated. This enables the `var(--font-inter)` pattern in Tailwind/CSS modules.
- **SSR font styles collection**: On the server (`typeof document === "undefined"`), CSS rules are collected into an array (`ssrFontStyles`) for injection in `<head>`. On the client, `<style>` tags are directly appended to `<head>`.

## Next.js 16 Async Params

- **Next.js 15+ changed `params` and `searchParams` to Promises**: Page components receive `{ params: Promise<{ slug: string }> }` and must `await params` to access values. This is a breaking change from pre-15 where params were plain objects.
- **Backward compatibility via "thenable objects"**: `Object.assign(Promise.resolve(params), params)` creates an object that works both as a Promise (`await params`) and as a plain object (`params.id`). This lets pre-15 and post-15 code coexist.
- **`generateMetadata` and `generateViewport` also receive thenable params**: They follow the same async pattern.
- **`searchParams` must also be passed to page components**: Next.js passes `searchParams` as a prop to page components. Previously we only passed `params`.

## useLinkStatus and onNavigate

- **`useLinkStatus`** is a new hook from `next/link` (Next.js 16). Returns `{ pending: boolean }` indicating whether a navigation triggered by the enclosing `<Link>` is in progress.
- **`onNavigate`** is a new prop on `<Link>` (Next.js 16) for View Transitions support. Called with `{ url: URL }` before navigation happens.
- **`LinkStatusContext`** provides the pending state to descendant components via React context.

## Production Server Compression

- **Brotli preferred over gzip**: `negotiateEncoding` returns `br > gzip > deflate` based on Accept-Encoding header.
- **1KB minimum threshold**: Bodies smaller than 1024 bytes skip compression — the overhead isn't worth it.
- **SSR output intercepted for compression**: The `res.writeHead/write/end` methods are wrapped to buffer SSR output, then compress before sending. Original methods are restored after.
- **Binary formats excluded**: Only text-based content types (HTML, JS, CSS, JSON, SVG, WASM) are compressed.

## App Router Playground (Ecosystem Fixture)

- **Vercel's official Next.js App Router demo** (github.com/vercel/next-app-router-playground) cloned as `fixtures/ecosystem/app-router-playground/`.
- **Uses `'use cache'` extensively**: File-level and function-level caching directives. We strip these with a custom Vite plugin (not yet supported).
- **Uses `#/*` path aliases**: tsconfig `paths` maps `#/*` to project root. Handled via Vite `resolve.alias`.
- **`server-only` package** needs an empty shim module — it's a build-time guard that throws if imported in client bundles.
- **MDX support** via `@next/mdx` + CodeHike — replaced with `@mdx-js/rollup` Vite plugin. Simple MDX (markdown without codehike annotations) renders fine. CodeHike-specific syntax would need `codehike` dep.
- **`connection()` from `next/server`** already shimmed as a no-op (forces dynamic rendering).

## SSR Navigation Context for "use client" Components (2026-02-14)

- **Critical discovery**: `"use client"` components that use `usePathname()`, `useSearchParams()`, or `useSelectedLayoutSegment()` during SSR were failing with "called outside of request context" because the SSR Vite environment has a **separate module instance** of `next/navigation` from the RSC environment. Even though we set `setNavigationContext()` in the RSC entry, the SSR entry's copy was never initialized.
- **Fix**: Pass the current navigation context (pathname, searchParams, params) from the RSC entry to the SSR entry via the `handleSsr(rscStream, navContext)` call. The SSR entry calls `setNavigationContext(navContext)` before rendering and cleans up afterward.
- **Pattern**: Any per-request state that needs to be shared between RSC and SSR environments must be explicitly passed across the environment boundary — they don't share module state.

## App Router Playground Results (2026-02-14)

- **10 out of 11 top-level routes render successfully** on first try after the nav context fix.
- **All dynamic sub-routes work**: `/layouts/electronics`, `/layouts/electronics/phones`, `/loading/electronics`, `/error/electronics`, `/not-found/electronics` — all 200.
- **`/view-transitions` fails** because it imports `ViewTransition` from `react`, which is only in React 19 canary builds, not the stable release.
- **`workspace:*` protocol** is pnpm-specific and doesn't work with npm. Changed to `"*"` and added `fixtures/ecosystem/*` to root workspaces.
- **bare `app/` imports** from tsconfig `baseUrl: "."` need a Vite `resolve.alias` mapping (`"app": path.resolve(__dirname, "app")`).
- **`codehike` dependency** was too heavy for a demo fixture. Replaced `ui/codehike.tsx` with a simplified shim that provides the same exports (`Grid`, `Mdx`) without `codehike/blocks`, `codehike/code`, `zod`, or `mdx/types` dependencies.

## Benchmarks (Phase 5)

- **vinext builds 2.6x faster** than Next.js 16 with Turbopack (2.09s vs 5.43s, 33-route App Router app).
- **vinext produces 55% smaller client bundles** (75.4 KB vs 168.9 KB gzipped).
- **Dev server cold start 33% faster** (1.16s vs 1.72s).
- **Memory usage identical** (~88 MB peak RSS for both).
- **vinext builds are more consistent** (stddev 13ms vs 99ms for Next.js).
- **Symlinks don't work with Next.js/Turbopack** — must copy shared app directories. Our `generate-app.mjs` now copies to both project directories.
- **`turbopack.root`** must be set in next.config.ts if there are multiple lockfiles in parent directories, otherwise Turbopack picks the wrong workspace root.
- **`process.cwd()` works** but Node ESM imports (`import { dirname }`) crash in next.config.ts because Next.js 16 compiles configs as CJS (`exports is not defined in ES module scope`).

## Ecosystem Libraries

- **`next/navigation.js` (with .js extension)** — Libraries like nuqs import `next/navigation.js` rather than `next/navigation`. Vite's `resolve.alias` does exact string matching, so `"next/navigation"` doesn't match `"next/navigation.js"`. Fixed by adding a `resolveId` hook that strips `.js` from `next/*` imports and redirects through our shim map.
- **next-themes works out of the box** — ThemeProvider, `useTheme`, SSR script injection, flash-free theme detection all work. 4/4 tests pass.
- **nuqs works via `npx vite`** (confirmed SSR output with correct default state) but fails in vitest's `createServer` because the RSC module runner's customization hooks bypass Vite's `resolveId` for `next` package resolution. This is a test infrastructure limitation, not a plugin bug.
- **next-intl requires deep integration** — it expects a plugin from `next.config.ts` that injects config at build time (via `createNextIntlPlugin`). Simply installing and importing doesn't work — we'd need to shim `next-intl`'s config resolution mechanism.

## CLI & Build

- **Vite 8 renamed `esbuild` config to `oxc`** — our plugin sets `esbuild: { jsx: "automatic" }` which triggers a deprecation warning in Vite 8. Fixed by detecting the Vite major version at runtime via `createRequire(cwd + "/package.json")` and conditionally setting `oxc` or `esbuild`. Static `import { version } from "vite"` doesn't work because the plugin's compiled output resolves `vite` from its own `node_modules` (workspace root = Vite 7), not the consumer project's Vite 8.
- **vinext CLI architecture** — the CLI is bundled into the main `vinext` package (not a separate package) via a `bin` entry pointing to `dist/cli.js`. It imports `./index.js` directly (relative import, not the package name) to avoid circular resolution. The CLI auto-detects `app/` vs `pages/` and configures Vite+RSC without needing a `vite.config.ts`. For App Router, it uses `createBuilder()` + `builder.buildApp()` for production builds.

## Shallow Routing & Navigation Hooks (Client-Side)

- **`require("react")` in navigation shim crashes browser ESM** — the navigation shim used `require("react")` in a `requireReact()` helper to dynamically load React hooks. This was meant to avoid RSC environment issues, but when the shim is loaded in the browser (via `"use client"` components), `require` is undefined in ESM context. The error manifests as `"require is not defined"` in the error boundary. Fixed by using a top-level `import { useSyncExternalStore } from "react"` instead.
- **`useSyncExternalStore` snapshot must return referentially stable values** — the `useSearchParams()` hook's `getSnapshot` was returning `new URLSearchParams(window.location.search)` on every call. Since `useSyncExternalStore` compares snapshots with `Object.is()`, two different `URLSearchParams` instances are never equal, causing infinite re-render loops or React bail-outs. Fixed by caching the `URLSearchParams` instance and only creating a new one when `window.location.search` actually changes.
- **`usePathname()`/`useSearchParams()` throw during SSR of "use client" components** — these hooks checked `isServer` (set at module load time) and threw `"called outside of a request context"` when `_serverContext` was null. But during SSR of `"use client"` components, the RSC SSR pass renders them server-side where `window` is undefined and context may not be set. The throw prevented the page from rendering at all. Fixed by returning safe fallbacks (`"/"` for pathname, empty `URLSearchParams` for search) instead of throwing — the client hydration will pick up the real values.
