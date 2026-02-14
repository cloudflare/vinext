# Discovery Journal

Running log of non-obvious findings, gotchas, and architectural decisions made during development. Append new entries at the bottom of the relevant section (or add new sections as needed).

---

## Vite 7

- **SSR uses `ESModulesEvaluator`** which doesn't define `module`. React (CJS) must be externalized via `ssr.external: ["react", "react-dom", "react-dom/server"]`.
- **`appType: "custom"`** must be set to disable Vite's SPA fallback, otherwise Vite intercepts requests before our middleware.
- **`configFile: false`** is needed in programmatic test servers, otherwise Vite auto-loads the fixture's `vite.config.ts` causing duplicate plugin registration and config conflicts.
- **`transformIndexHtml`** extracts inline `<script type="module">` into proxy modules (`html-proxy`), which is fine for HMR but means client-side navigation cannot parse module URLs from HTML. Solution: embed module URLs in `__NEXT_DATA__.__nextcompat`.
- **Vite 7 rewrites `/` to `/index.html`** in post-middleware even with `appType: "custom"`. Our middleware normalizes `/index.html` back to `/` by checking `rawPathname.endsWith("/index.html")`.
- **Virtual modules in build**: Vite prefixes virtual module IDs with the root path when resolving SSR build entries. The `resolveId` hook must handle both `virtual:nextcompat-server-entry` and `<root>/virtual:nextcompat-server-entry`.
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
- **Plugin must be built to `dist/`** before running Playwright E2E tests or the realworld fixture, because the fixture's `vite.config.ts` imports from `vite-plugin-nextcompat` which resolves to `dist/index.js`.

## Phase 2: @vitejs/plugin-rsc (Research)

- **`@vitejs/plugin-rsc`** (v0.5.19) is the official Vite RSC plugin. Handles bundler transforms (`"use client"` / `"use server"`), RSC stream serialization (wraps `react-server-dom-webpack`), multi-environment builds (RSC/SSR/Client), CSS code-splitting, and HMR.
- **It does NOT handle** routing, request lifecycle, layout nesting, or navigation — those are the framework's (our) responsibility.
- Key sub-path exports: `@vitejs/plugin-rsc/rsc` (renderToReadableStream), `@vitejs/plugin-rsc/ssr` (createFromReadableStream), `@vitejs/plugin-rsc/browser` (createFromReadableStream, createFromFetch, encodeReply, setServerCallback).
- Uses `import.meta.viteRsc.loadModule()` for cross-environment communication.
- Uses `rsc-html-stream` package for injecting RSC payload into HTML.
- We initially planned `serverHandler: false` to own the request lifecycle, but the **default behavior is better for dev**: the plugin-rsc sets up its own middleware calling the RSC entry's `default` export. This means we do NOT need custom middleware for app routes in dev mode — the plugin handles request routing automatically.
- **Our RSC entry's `default` export** is the request handler. Plugin-rsc calls it for every request and our code does route matching, builds the React tree (layouts + page), renders to RSC stream, and delegates to the SSR entry for HTML.
- **CSS is auto-injected** by plugin-rsc's `rscCssTransform` — no manual `loadCss()` calls needed for server components.
- **Virtual module IDs for entries**: We pass `entries: { rsc: "virtual:nextcompat-rsc-entry", ssr: "virtual:nextcompat-app-ssr-entry", client: "virtual:nextcompat-app-browser-entry" }` to the RSC plugin, and our `resolveId`/`load` hooks serve the generated code. Works seamlessly.
- **RSC stream format**: The `.rsc` endpoint returns `text/x-component` content type. The stream contains serialized React elements with client references, metadata like file paths, and component definitions.
- **Bootstrap script injection**: Plugin-rsc auto-injects `<script id="_R_">import("/@id/...")` into HTML for client hydration. No manual script tag needed.
- **Shim imports in generated code**: The RSC entry imports `next/navigation` and `next/headers` which resolve through Vite aliases to our shim files. Internal setter functions (`setNavigationContext`, `setHeadersContext`) are exported from the shims and called by the generated entry code.
- **Virtual module caching**: Vite caches virtual module results from `load()` hooks. When running the fixture dev server (which uses the built plugin from `dist/`), changes to the generator TypeScript source require a `tsc` rebuild before taking effect. The `vitest` tests use the source TS directly and always pick up changes.
- **error.tsx must be `"use client"`**: In the RSC model, ErrorBoundary is a class component using `getDerivedStateFromError` which is client-only. We created a generic `ErrorBoundary` component in `shims/error-boundary.tsx` that wraps the user's error.tsx component. It's imported in the RSC entry and the RSC bundler handles the client reference.
- **not-found.tsx handling**: Route-level not-found works per-segment, but global 404 (no route match) needs to reference the root not-found module directly. We resolve the root route's `notFoundPath` at code-generation time and emit `rootNotFoundModule` as a top-level variable, avoiding the need to search routes at runtime.
- **Virtual module `\0` prefix in client environment**: When `@vitejs/plugin-rsc` generates its `virtual:vite-rsc/entry-browser` module, it imports our virtual entry using the already-resolved `\0`-prefixed ID (e.g., `\0virtual:nextcompat-app-browser-entry`). Vite's `import-analysis` plugin in the client environment fails to resolve this. Fix: `resolveId` must strip the `\0` prefix before matching, e.g., `const cleanId = id.startsWith("\0") ? id.slice(1) : id`.
- **Server Actions transport**: `@vitejs/plugin-rsc` is transport-agnostic for server actions. It provides serialization primitives (`encodeReply`/`decodeReply`/`loadServerAction`) but we must implement the HTTP transport. Convention: POST to `pathname.rsc` with `x-rsc-action: <actionId>` header. The RSC entry must `decodeReply` the body, `loadServerAction(id)`, execute it, then re-render the page tree and include `returnValue` in the RSC stream payload. The browser uses `setServerCallback` to register the action handler.
- **RSC action response shape**: When server actions complete, the RSC stream must serialize `{ root: <pageElement>, returnValue: { ok: true, data } }`. The browser deserializes this, renders `result.root` and returns `result.returnValue.data` to the caller. This allows the page to reflect mutations while the action return value is delivered to the calling component's state.

## Middleware

- **middleware.ts runs in Node**, not Edge Runtime. This is a deliberate departure from Next.js (which uses Edge Runtime). Since nextcompat targets "deploy anywhere" including $5 VPS, Node is the pragmatic choice. The middleware uses standard Web APIs (`Request`/`Response`/`NextRequest`/`NextResponse`) so the API surface is compatible.
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
