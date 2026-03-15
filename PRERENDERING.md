# Prerendering Plan

Design document for implementing a prerendering phase in vinext that matches Next.js behavior.

**Scope:** This document covers route classification, prerender execution, output artifacts, redesigned static export, and the test strategy. It does **not** cover populating the incremental cache handler with prerender results — that is a separate follow-up.

---

## 1. How Next.js Prerendering Works (Reference Behavior)

### 1.1 Route Classification

Next.js classifies every route at build time into one of three rendering modes:

| Symbol | Mode    | When                                                                        |
| ------ | ------- | --------------------------------------------------------------------------- |
| ○      | Static  | No dynamic APIs used; rendered once at build time                           |
| ◐      | ISR     | `revalidate > 0`; rendered at build time and re-rendered on a timer         |
| ƒ      | Dynamic | `force-dynamic`, `revalidate=0`, `getServerSideProps`, or dynamic API calls |

**App Router classification rules:**

- `export const dynamic = "force-static"` → Static
- `export const dynamic = "error"` → Static (throws if dynamic APIs are called)
- `export const dynamic = "force-dynamic"` → Dynamic
- `export const revalidate = Infinity` → Static
- `export const revalidate = 0` → Dynamic
- `export const revalidate = N` (N > 0) → ISR with interval N
- Dynamic URL + `generateStaticParams` → the expanded paths are Static
- Dynamic URL without `generateStaticParams` and no explicit config → Dynamic (default)
- No explicit config, no dynamic URL → Unknown (could be static or dynamic; Next.js determines at runtime during the build via execution)

**Pages Router classification rules:**

- `getServerSideProps` → Dynamic
- `getStaticProps` with no `revalidate` (or `revalidate: false`) → Static
- `getStaticProps` with `revalidate: N` (N > 0) → ISR
- `getStaticProps` with `revalidate: 0` → Dynamic
- No data-fetching exports → Static
- API route → API (skipped for prerendering)

### 1.2 What Prerendering Produces

For each static or ISR route, Next.js produces:

1. **HTML file** — fully rendered HTML at the path, e.g. `blog/hello-world.html`
2. **RSC payload** (App Router only) — `blog/hello-world.rsc` — the serialized RSC stream for client-side navigation
3. **Page data JSON** (Pages Router only) — `_next/data/<buildId>/blog/hello-world.json` — the `pageProps` blob used for client-side hydration
4. **Prerender manifest** — `prerender-manifest.json` — maps every prerendered route to its revalidate interval, src route pattern, and `dynamicParams` setting; read at runtime to determine ISR intervals without module re-evaluation
5. **Routes manifest** — `routes-manifest.json` — lists all routes (static, dynamic, rewrites, redirects, headers)

**Note for vinext:** Next.js needs the prerender manifest because its production server doesn't have the original module source available to re-read `export const revalidate`. Vinext is different: `app-rsc-entry.ts` reads `revalidate` directly from live module exports at request time (line 2263), so the manifest's `initialRevalidateSeconds` field adds no new information. Vinext does **not** need to produce a Next.js-format prerender manifest. See section 3.5 for what it uses instead.

### 1.3 When Prerendering Runs

Prerendering runs **as part of `next build`**, not only for `output: 'export'`. Static and ISR routes are always prerendered into the `.next/` output directory. The difference is:

- **Default mode** — prerendered HTML/JSON is cached and served by the Node.js/Workers server; dynamic routes are handled at request time
- **`output: 'export'`** — all routes must be statically renderable (no SSR); produces a portable directory of files for static hosting; ISR routes and dynamic routes without `generateStaticParams` are errors

---

## 2. Current State and Gaps

### 2.1 What Exists

- `build/static-export.ts` — Pages Router prerender works well for `output: 'export'` mode; App Router prerender uses HTTP fetching from a running dev server (fragile)
- `build/report.ts` — accurate static-analysis-based route classifier; used for the build report table only
- `routing/app-router.ts`, `routing/pages-router.ts` — complete route scanners with full type information
- `server/isr-cache.ts` — ISR cache layer (stale-while-revalidate, dedup, tag invalidation)

### 2.2 What Is Missing

1. **Prerendering is only for `output: 'export'`** — there is no prerender step for the default (server) build mode
2. **App Router static export uses HTTP fetching** — fragile; requires a running dev server; does not produce RSC payloads
3. **No prerender manifest** — no `prerender-manifest.json` produced; but vinext doesn't need one (see §1.2)
4. **No page data JSON** — Pages Router prerender does not write `_next/data/<buildId>/*.json` files
5. **No RSC payload files** — App Router prerender does not write `.rsc` files
6. **No `dynamicParams` support** — the `export const dynamicParams = false` flag is not respected during prerender (should 404 for unknown params)
7. **Static export and prerender are conflated** — the same code path handles both; they should be separated

---

## 3. Redesigned Architecture

### 3.1 Two Distinct Phases

```
vinext build
  └── Vite build (RSC/SSR/client bundles)
  └── Prerender phase               ← new
        ├── Classify all routes
        ├── Expand dynamic routes (generateStaticParams / getStaticPaths)
        ├── Render each static/ISR route
        └── Write output artifacts
              ├── HTML files         (all modes)
              ├── RSC payloads       (App Router, .rsc)
              ├── Page data JSON     (Pages Router, _next/data/)
              └── vinext build index (vinext-prerender.json, minimal)

output: 'export' mode
  └── Same prerender phase, but:
        - SSR routes are errors (not skipped)
        - ISR routes are treated as static (revalidate ignored)
        - No server required to serve output
```

### 3.2 New Module: `build/prerender.ts`

A new module responsible for the prerender phase. The `static-export.ts` module will be refactored to use it (or replaced by it).

```ts
// packages/vinext/src/build/prerender.ts

export interface PrerenderResult {
  /** One entry per route (including skipped/error routes) */
  routes: PrerenderRouteResult[];
}

export type PrerenderRouteResult =
  | { route: string; status: 'rendered';    outputFiles: string[]; revalidate?: number }
  | { route: string; status: 'skipped';     reason: string }
  | { route: string; status: 'error';       error: string };

export interface PrerenderOptions {
  mode: 'default' | 'export';
  outDir: string;
  buildId: string;
  // ... server, routes, config
}

export async function prerenderPages(options: PrerenderOptions): Promise<PrerenderResult> { ... }
export async function prerenderApp(options: PrerenderOptions): Promise<PrerenderResult> { ... }
```

### 3.3 Pages Router Prerender Logic

For each non-API, non-internal route:

1. Load module via Vite SSR (`server.ssrLoadModule`)
2. **SSR routes** (`getServerSideProps`):
   - `mode: 'default'` → skip (mark as `skipped`, reason: `'ssr'`)
   - `mode: 'export'` → error (mark as `error`)
3. **Static/ISR routes**:
   - Expand dynamic routes via `getStaticPaths` (must be `fallback: false` for export mode; `fallback: 'blocking'` is allowed in default mode and treated as ISR)
   - Call `getStaticProps` with params
   - Render HTML using `renderToReadableStream` (existing `renderStaticPage` logic)
   - Write `<route>.html` (or `<route>/index.html` if `trailingSlash`)
   - Write `_next/data/<buildId>/<route>.json` with `{ pageProps }`
   - Record in manifest with `revalidate` interval
4. Render 404 page

### 3.4 App Router Prerender Logic

**Replace HTTP fetching** with direct module invocation through the built RSC entry:

1. Load the built prod server entry (`server/prod-server.ts` or the RSC entry directly)
2. For each page route:
   - **Dynamic routes with `generateStaticParams`**: resolve params top-down (existing `resolveParentParams` logic), call `generateStaticParams` for each
   - **Dynamic routes without `generateStaticParams`**:
     - `mode: 'default'` → skip
     - `mode: 'export'` → error
   - **Static/ISR routes**: render directly
3. For each resolved URL:
   - Invoke the RSC request handler with a synthetic `Request` object (no real HTTP)
   - Capture the RSC stream → write `<route>.rsc`
   - Pipe through the SSR entry → capture HTML → write `<route>.html`
   - Record in manifest with `revalidate` interval

**Key change:** Instead of `fetch(baseUrl + urlPath)`, construct a `new Request(url)` and call the internal request handler directly. This removes the requirement for a running dev server during the build and makes the render deterministic.

### 3.5 Vinext Build Index (replaces Next.js prerender manifest)

Vinext does not need a Next.js-format `prerender-manifest.json`. The production server reads `revalidate` from live module exports, not from a file on disk.

What is needed is a minimal index of which paths were prerendered, so the server can serve the pre-built `.html`/`.rsc` files as static responses on the first hit (before the ISR loop kicks in). This is the **ISR cache population problem** and is out of scope for this plan (see §8).

The only artifact the prerender phase needs to write is a small `vinext-prerender.json` used during testing to assert structural output:

```json
{
  "routes": [
    { "route": "/", "status": "rendered", "revalidate": false },
    { "route": "/blog/hello-world", "status": "rendered", "revalidate": false },
    { "route": "/isr-test", "status": "rendered", "revalidate": 1 },
    { "route": "/ssr", "status": "skipped", "reason": "ssr" }
  ]
}
```

This file is written to `outDir` after the prerender phase and is the primary thing the tests read and assert against. It is not consumed by the production server.

### 3.6 Static Export Mode Changes

The existing `output: 'export'` behavior is preserved but reimplemented on top of the new prerender layer:

- Same route expansion (getStaticPaths / generateStaticParams)
- Same HTML output structure
- Additional validation: SSR routes are build errors; dynamic routes without static params are build errors
- No manifest needed (static file host has no runtime)
- App Router export no longer requires a running dev server

---

## 4. Route Classification During Prerender

The existing `build/report.ts` classifier uses static source analysis and is accurate for routes with explicit config (`force-static`, `force-dynamic`, `revalidate`, `getServerSideProps`, etc.). It cannot detect implicit dynamic API usage (`headers()`, `cookies()`, `connection()`) — those routes are marked "unknown".

The "unknown" category is a real problem for prerendering: the `app-basic` fixture has many routes with no explicit config and no dynamic URL segments (e.g. `/`, `/about`, `/dashboard`, `/features`). These are genuinely static and must be prerendered. Skipping all "unknown" routes would leave the most important pages unrendered.

**Strategy: speculative static rendering**

This is exactly what Next.js does. For any "unknown" App Router route:

1. Attempt to render it with an empty headers/cookies context (same as `force-static`)
2. The dynamic API shims (`headers()`, `cookies()`, `connection()`) throw a `DynamicUsageError` when called in a static context
3. If a `DynamicUsageError` is thrown during render, mark the route as `skipped` with `reason: 'dynamic'`
4. If render succeeds, mark as `rendered`

The machinery already exists: `app-rsc-entry.ts` sets `headersContext` with an `accessError` for `dynamic = 'error'` (lines 2282–2297), and the shims throw when that error is set. Speculative rendering reuses the same path.

This is **required for Phase 2** (App Router prerender), not a future optimization. Without it, no static App Router routes without explicit `export const dynamic = "force-static"` would be prerendered.

**Pages Router** does not have this problem: `getServerSideProps` is the only indicator of dynamic behavior and is caught by static analysis with 100% accuracy.

---

## 5. Test Plan

Tests assert the **structural output of prerendering** — which routes were rendered, which were skipped, which errored, and what files were produced — as structured objects. Tests do **not** assert on raw HTML content (leave that to E2E/Playwright).

### 5.1 Test File Location

`tests/prerender.test.ts` — new Vitest test file

### 5.2 Test Helpers

```ts
interface PrerenderRouteResult {
  route: string;
  status: "rendered" | "skipped" | "error";
  // Only for 'rendered':
  outputFiles?: string[]; // relative to outDir
  revalidate?: number | false; // false = static, number = ISR interval
  // Only for 'skipped':
  reason?: string; // 'ssr' | 'dynamic' | 'no-static-params'
  // Only for 'error':
  error?: string; // error message (partial match ok)
}
```

### 5.3 Pages Router Test Cases (`pages-basic` fixture)

#### `output: 'default'` mode

```ts
expect(results).toEqual([
  // Static pages (no data fetching)
  {
    route: "/",
    status: "rendered",
    outputFiles: ["index.html", "_next/data/BUILD_ID/index.json"],
    revalidate: false,
  },
  {
    route: "/about",
    status: "rendered",
    outputFiles: ["about.html", "_next/data/BUILD_ID/about.json"],
    revalidate: false,
  },
  { route: "/404", status: "rendered", outputFiles: ["404.html"], revalidate: false },

  // Static dynamic route (getStaticPaths + getStaticProps, fallback: false)
  {
    route: "/blog/hello-world",
    status: "rendered",
    outputFiles: ["blog/hello-world.html", "_next/data/BUILD_ID/blog/hello-world.json"],
    revalidate: false,
  },
  {
    route: "/blog/getting-started",
    status: "rendered",
    outputFiles: ["blog/getting-started.html", "_next/data/BUILD_ID/blog/getting-started.json"],
    revalidate: false,
  },

  // Static dynamic route (getStaticPaths + getStaticProps, fallback: 'blocking')
  // fallback: 'blocking' is treated as ISR in default mode
  {
    route: "/articles/1",
    status: "rendered",
    outputFiles: ["articles/1.html", "_next/data/BUILD_ID/articles/1.json"],
    revalidate: false,
  },
  {
    route: "/articles/2",
    status: "rendered",
    outputFiles: ["articles/2.html", "_next/data/BUILD_ID/articles/2.json"],
    revalidate: false,
  },

  // ISR page
  {
    route: "/isr-test",
    status: "rendered",
    outputFiles: ["isr-test.html", "_next/data/BUILD_ID/isr-test.json"],
    revalidate: 1,
  },

  // SSR pages — skipped in default mode (served at request time)
  { route: "/ssr", status: "skipped", reason: "ssr" },
  { route: "/ssr-headers", status: "skipped", reason: "ssr" },
  { route: "/posts/:id", status: "skipped", reason: "ssr" }, // getServerSideProps

  // API routes — always skipped
  { route: "/api/hello", status: "skipped", reason: "api" },
  { route: "/api/users/:id", status: "skipped", reason: "api" },
  // ... (all other api/ routes)
]);
```

#### `output: 'export'` mode

```ts
expect(results).toEqual([
  // Same static/ISR routes rendered (ISR treated as static — revalidate ignored)
  { route: '/',               status: 'rendered', ... },
  { route: '/about',          status: 'rendered', ... },
  { route: '/blog/hello-world',     status: 'rendered', ... },
  { route: '/blog/getting-started', status: 'rendered', ... },
  { route: '/articles/1',     status: 'rendered', ... },
  { route: '/articles/2',     status: 'rendered', ... },
  { route: '/isr-test',       status: 'rendered', revalidate: false },  // revalidate ignored in export mode

  // SSR pages — errors in export mode
  { route: '/ssr',         status: 'error', error: expect.stringContaining('getServerSideProps') },
  { route: '/ssr-headers', status: 'error', error: expect.stringContaining('getServerSideProps') },
  { route: '/posts/:id',   status: 'error', error: expect.stringContaining('getServerSideProps') },

  // API routes — skipped (warning)
  { route: '/api/hello',     status: 'skipped', reason: 'api' },
  // ...
]);
```

### 5.4 App Router Test Cases (`app-basic` fixture)

#### Static routes (no config or `force-static`)

```ts
[
  { route: "/", status: "rendered", outputFiles: ["index.html", "index.rsc"], revalidate: false },
  {
    route: "/about",
    status: "rendered",
    outputFiles: ["about.html", "about.rsc"],
    revalidate: false,
  },
  {
    route: "/static-test",
    status: "rendered",
    outputFiles: ["static-test.html", "static-test.rsc"],
    revalidate: false,
  },
  { route: "/revalidate-infinity-test", status: "rendered", revalidate: false },

  // Route group (marketing) → /features
  {
    route: "/features",
    status: "rendered",
    outputFiles: ["features.html", "features.rsc"],
    revalidate: false,
  },

  // Dashboard (no config, non-dynamic) — static
  { route: "/dashboard", status: "rendered", revalidate: false },
  { route: "/dashboard/settings", status: "rendered", revalidate: false },
  { route: "/dashboard/missing", status: "rendered", revalidate: false },
];
```

#### ISR routes

```ts
[
  {
    route: "/isr-test",
    status: "rendered",
    outputFiles: ["isr-test.html", "isr-test.rsc"],
    revalidate: 1,
  },
  {
    route: "/revalidate-test",
    status: "rendered",
    outputFiles: ["revalidate-test.html", "revalidate-test.rsc"],
    revalidate: 60,
  },
];
```

#### Dynamic routes skipped (`force-dynamic`, `revalidate=0`, no `generateStaticParams`)

```ts
[
  { route: "/dynamic-test", status: "skipped", reason: "dynamic" }, // force-dynamic
  { route: "/revalidate-zero-test", status: "skipped", reason: "dynamic" }, // revalidate=0
  { route: "/connection-test", status: "skipped", reason: "dynamic" }, // unknown → skipped in phase 1
  { route: "/headers-test", status: "skipped", reason: "dynamic" },

  // Dynamic URL, no generateStaticParams → skipped in default mode
  { route: "/photos/:id", status: "skipped", reason: "no-static-params" },
  { route: "/auth/:auth-method", status: "skipped", reason: "no-static-params" },
  { route: "/docs/:slug+", status: "skipped", reason: "no-static-params" },
  { route: "/locale-test/:locale/:path+", status: "skipped", reason: "no-static-params" },
];
```

#### Dynamic routes with `generateStaticParams`

```ts
[
  // /blog/[slug] → 3 paths
  {
    route: "/blog/hello-world",
    status: "rendered",
    outputFiles: ["blog/hello-world.html", "blog/hello-world.rsc"],
    revalidate: false,
  },
  {
    route: "/blog/getting-started",
    status: "rendered",
    outputFiles: ["blog/getting-started.html", "blog/getting-started.rsc"],
    revalidate: false,
  },
  {
    route: "/blog/advanced-guide",
    status: "rendered",
    outputFiles: ["blog/advanced-guide.html", "blog/advanced-guide.rsc"],
    revalidate: false,
  },

  // /products/[id] → 3 paths (dynamicParams=false)
  { route: "/products/1", status: "rendered", revalidate: false },
  { route: "/products/2", status: "rendered", revalidate: false },
  { route: "/products/3", status: "rendered", revalidate: false },

  // /shop/[category] → 2 paths
  { route: "/shop/electronics", status: "rendered", revalidate: false },
  { route: "/shop/clothing", status: "rendered", revalidate: false },

  // /shop/[category]/[item] → 4 paths (top-down params)
  { route: "/shop/electronics/phone", status: "rendered", revalidate: false },
  { route: "/shop/electronics/laptop", status: "rendered", revalidate: false },
  { route: "/shop/clothing/shirt", status: "rendered", revalidate: false },
  { route: "/shop/clothing/pants", status: "rendered", revalidate: false },
];
```

#### API routes — always skipped

```ts
[
  { route: "/api/hello", status: "skipped", reason: "api" },
  { route: "/api/items/:id", status: "skipped", reason: "api" },
  // ... all /api/* and /nextjs-compat/api/* routes
];
```

#### Build index assertions

```ts
// vinext-prerender.json contains exactly the route results
const index = JSON.parse(fs.readFileSync(path.join(outDir, "vinext-prerender.json"), "utf8"));

// Rendered routes are present
const rendered = index.routes.filter((r) => r.status === "rendered").map((r) => r.route);
expect(rendered).toEqual(
  expect.arrayContaining([
    "/",
    "/blog/hello-world",
    "/blog/getting-started",
    "/blog/advanced-guide",
    "/products/1",
    "/products/2",
    "/products/3",
    "/shop/electronics",
    "/shop/clothing",
    "/shop/electronics/phone",
    // ...
  ]),
);

// ISR routes have correct revalidate intervals
const isrTest = index.routes.find((r) => r.route === "/isr-test");
expect(isrTest).toEqual({ route: "/isr-test", status: "rendered", revalidate: 1 });

// Static routes have revalidate: false
const home = index.routes.find((r) => r.route === "/");
expect(home).toEqual({ route: "/", status: "rendered", revalidate: false });

// Skipped/dynamic routes are present with correct reason
const dynamic = index.routes.find((r) => r.route === "/dynamic-test");
expect(dynamic).toEqual({ route: "/dynamic-test", status: "skipped", reason: "dynamic" });
```

---

## 6. Implementation Phases

### Phase 1 — Prerender result type + Pages Router

**Goal:** Introduce the `PrerenderResult` / `PrerenderRouteResult` types and implement a clean Pages Router prerender that produces structured results.

1. Create `packages/vinext/src/build/prerender.ts` with:
   - `PrerenderResult`, `PrerenderRouteResult`, `PrerenderOptions` types
   - `prerenderPages()` — refactored from `staticExportPages()`, plus:
     - returns `PrerenderRouteResult[]` instead of `StaticExportResult`
     - handles `mode: 'default'` (skip SSR) vs `mode: 'export'` (error on SSR)
     - writes `_next/data/<buildId>/*.json` page data files
2. Refactor `staticExportPages()` in `static-export.ts` to delegate to `prerenderPages()`
3. Add `tests/prerender.test.ts` with Pages Router test cases
4. Run: `pnpm test tests/prerender.test.ts`

### Phase 2 — App Router prerender (no HTTP, speculative rendering)

**Goal:** Replace the HTTP-fetch approach in `staticExportApp()` with direct module invocation, and implement speculative static rendering for "unknown" routes.

1. Implement `prerenderApp()` in `prerender.ts`:
   - Use `resolveParentParams()` (already exists) for top-down GSP resolution
   - Construct synthetic `Request` objects for the RSC handler (no `fetch(baseUrl)`)
   - For routes classified as "unknown" (no explicit config, non-dynamic URL): attempt render with empty headers/cookies context; catch `DynamicUsageError`; mark as `skipped` with `reason: 'dynamic'` if thrown
   - Capture RSC stream and SSR HTML separately
   - Write `.html` and `.rsc` output files
   - Write `vinext-prerender.json` index
2. Refactor `staticExportApp()` to delegate to `prerenderApp()`
3. Add App Router test cases to `tests/prerender.test.ts` — including assertions that `/`, `/about`, `/dashboard` etc. render as `status: 'rendered'`
4. Run: `pnpm test tests/prerender.test.ts`

### Phase 3 — Build integration

**Goal:** `vinext build` runs the prerender phase automatically for both routers.

1. Update `cli.ts` `buildApp()` / `buildPages()`:
   - After Vite build, call `prerenderApp()` / `prerenderPages()` with `mode: 'default'`
   - Write `vinext-prerender.json` to the output directory
   - Merge prerender results into the build report table (show rendered count per route type)
2. Update `formatBuildReport()` to distinguish between confirmed-static routes and speculatively-rendered routes
3. Run: `pnpm test tests/build-optimization.test.ts tests/deploy.test.ts`

---

## 7. File Map

| File                                         | Change                                                                             |
| -------------------------------------------- | ---------------------------------------------------------------------------------- |
| `packages/vinext/src/build/prerender.ts`     | **New** — core prerender logic, writes `vinext-prerender.json`                     |
| `packages/vinext/src/build/static-export.ts` | **Refactor** — delegate to `prerender.ts`; remove HTTP-fetch App Router path       |
| `packages/vinext/src/build/report.ts`        | **Minor** — accept prerender results in `buildReportRows` for rendered route count |
| `packages/vinext/src/cli.ts`                 | **Update** — call prerender phase after Vite build                                 |
| `tests/prerender.test.ts`                    | **New** — structured output assertions                                             |

---

## 8. Out of Scope

The following are **explicitly excluded** from this plan and will be handled separately:

- **Populating the ISR cache handler with prerender results** — `isrSet()` should be called for each rendered ISR route so the first request is a cache HIT. This is a follow-up. The `vinext-prerender.json` index is designed to be consumed by this future step.
- **Next.js-format `prerender-manifest.json`** — not needed; vinext reads `revalidate` from live module exports at request time and has no use for the file.
- **Partial prerendering (PPR)** — Next.js 15 feature; not planned.
- **`dynamicParams = false` enforcement at runtime** — the prerender identifies which routes have this set, but the server needs to 404 for unrecognized dynamic params. Tracked separately.
- **Incremental static regeneration in production builds** — the server-side ISR loop is already implemented; this plan only adds the initial prerender seed.
