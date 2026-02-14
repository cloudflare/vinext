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
- We set `serverHandler: false` so we own the full request lifecycle.
