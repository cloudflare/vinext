# vinext: Run Next.js Apps on Cloudflare Workers

## Thesis

Next.js is locked to Vercel. Cloudflare Workers is a fundamentally better
runtime — edge-first, V8 isolates, zero cold starts, global by default —
but you can't run Next.js on it without heroics. The
[OpenNext](https://opennext.js.org/) project exists solely to bridge this
gap, but it's constantly chasing Next.js internals that Vercel changes
without notice.

**vinext takes a different approach.** Instead of adapting Next.js's build
output for Workers, we reimplement the Next.js API surface on Vite —
a direct, API-compatible reimplementation where existing Next.js apps can
`npm uninstall next && npm install vinext` and run natively on Cloudflare
Workers. Not an adapter. Not a compatibility layer. A new build from
scratch that treats Workers as the primary target.

The goal: **any Next.js app deploys to Cloudflare with one command, and
it runs better there than anywhere else — including Vercel.**

## Why Cloudflare Workers

Cloudflare Workers offers things no other runtime does:

- **Zero cold starts** — V8 isolates, not containers. No 250ms Lambda spin-up.
- **Global by default** — Code runs in 300+ cities. No region selection.
- **Near-full Node.js compatibility** — `nodejs_compat` covers ~85% of
  Node.js APIs. `node:fs` is built-in (read-only `/bundle/` for Worker
  bundle files, writable `/tmp/` per-request) and can be extended with
  persistent mounts via [`worker-fs-mount`](https://github.com/danlapid/worker-fs-mount)
  — R2, Durable Objects (SQLite), or in-memory backends, all behind
  standard `fs.readFile`/`fs.writeFile` APIs.
  [Docs](https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/).
- **Integrated platform** — KV, R2, D1, Durable Objects, Queues, AI,
  Vectorize are all native bindings, not external services with network hops.
- **Web-standard APIs** — Workers speaks `Request`/`Response`/`fetch`
  natively. Standard Node.js APIs work too via `nodejs_compat`.
- **Smart Placement** — Automatically colocates compute with data when
  latency to a backend dominates.

Workers is not a constrained environment. It's Node-compatible AND has
platform capabilities that Node.js alone doesn't offer. The only reason
Next.js doesn't run there is that Next.js is built for Vercel's
infrastructure, and OpenNext's Cloudflare adapter is constantly playing
catch-up with Next.js internals.

vinext eliminates that problem. Keep your Next.js code. Deploy to Workers.
Get the full Cloudflare platform — KV for caching, R2 for storage, D1 for
databases, Durable Objects for stateful logic, AI for inference — all
as native bindings from your existing server code.

## Why Vite (Not Just Adapting Next.js)

We build on Vite rather than adapting Next.js's build output because:

- **Vite already handles** JSX/TSX, CSS Modules, HMR, code splitting, SSR
- **`@vitejs/plugin-rsc`** handles the full RSC pipeline (server/client
  boundaries, streaming, HMR)
- **`@cloudflare/vite-plugin`** runs code in `workerd` during dev for
  production-identical behavior — real Workers runtime, not a Node.js
  approximation
- **Standard build output** — no proprietary `.nft.json` trace files or
  Vercel-specific routing manifests to reverse-engineer
- **The hard parts (bundling, transforms, dev server) are what Vite does best**

Building on Vite means we're not chasing Next.js internals. We implement
the public API surface — the documented contract that apps actually depend
on — and produce standard Vite output that the Cloudflare plugin knows
how to deploy.

If vinext happens to work on other platforms (Node.js, Deno, etc.) because
we use Web-standard APIs, great. But Cloudflare Workers is THE target. We
will break non-Cloudflare paths to ship a better Workers experience.

## Design Principle: Pragmatic Compatibility, Not Bug-for-Bug Parity

The goal is **95%+ of real-world Next.js apps work out of the box** with
zero or minimal changes. That's different from reproducing every quirk.

**What we cover:**
- The documented, current Next.js API surface
- Behaviors that real apps depend on
- Common patterns from the ecosystem (popular libraries, typical project structures)

**What we skip or deprioritize:**
- Deprecated APIs that Next.js has removed or is removing
- Undocumented internal behaviors that happen to work but aren't part of
  the public contract
- Weird edge cases that cost disproportionate engineering effort relative
  to the number of apps that depend on them
- Behaviors that only exist because of Vercel-specific infrastructure

**When something doesn't work, we provide an off-ramp:**
- A clear **compatibility caveats** page documenting known differences,
  with workarounds for each
- **Codemods** (`npx vinext migrate`) that automatically transform
  code away from unsupported patterns. If we can't support a pattern, we
  can at least automate the migration off of it.
- **AI-assisted migration**: For edge cases that are too contextual for
  a mechanical codemod, use an LLM that understands both the Next.js API
  surface and the vinext surface. `npx vinext migrate` scans the
  project, flags incompatibilities, and offers AI-suggested fixes in
  context - not generic "here's the docs" but actual code changes specific
  to the user's file. Mechanical transforms (rename an import, swap an
  API call) use traditional codemods. Anything that requires understanding
  intent or refactoring a pattern gets the AI treatment.
- **Runtime warnings** when we detect usage of an unsupported API, pointing
  to the docs for the recommended alternative

**Before you even migrate, we tell you what to expect:**
- **`npx vinext check`** - point it at an existing Next.js app and it
  scans the codebase to produce a compatibility report:
  - Which `next/*` imports are used and whether they're supported
  - Which `next.config.js` options are in use and which we handle
  - Which third-party libraries have known Next.js-specific integrations
    (next-auth, @clerk/nextjs, @sentry/nextjs, etc.) and their status
  - Which file conventions are used (Pages Router, App Router, middleware,
    API routes) and coverage level
  - Specific files/lines flagged as potentially incompatible, with
    explanations of why and what to do about it
  - An overall compatibility score: "93% compatible, 4 issues to address"
  This can be an AI-powered analysis (feed the scan results + our known
  caveats to an LLM for contextual advice) or a pure static analysis
  tool, or both. Either way, the user knows before committing to the
  migration exactly what they're getting into.

The mental model: if a Next.js app was written following the official docs
and using current APIs, it should Just Work. If it's relying on a quirk
from Next.js 12 that was never documented, we'll help you migrate, but
we're not going to burn a week implementing it.

This is also where the test harness helps. When a test fails because of
a genuine edge case we choose not to support, we mark it as "skipped
(intentional)" with a note explaining why and what the alternative is.
The "Are We Vite Yet?" dashboard shows these separately from real failures.

## Compatibility Target

We target **the latest stable Next.js release only** (currently **16.x**).

No multi-version matrix. No chasing old releases. If an API was removed or
changed in 16.x, we implement the 16.x behavior. If someone is on an older
version, they upgrade Next.js first (which they should be doing anyway),
then migrate to vinext. One moving target is enough.

We can always broaden version support later once the core is solid. Starting
narrow keeps the scope sane.

**Deprecation policy:** If Next.js has explicitly deprecated an API, we
don't implement it. `getInitialProps`, legacy `<Image>` from `next/legacy/image`,
`next/amp`, etc. - skip them. If someone's app uses deprecated APIs, step one
is upgrading to current Next.js APIs (which they should do regardless), then
migrating to vinext.

## Design Principle: Cloudflare-First

This is the guiding principle behind every implementation decision.

Vercel optimizes for Vercel. **We optimize for Cloudflare.** Every feature
we build assumes Cloudflare Workers as the production runtime. If it also
works on Node.js or other platforms, great — but we will not compromise the
Cloudflare experience to maintain generic portability.

Concretely:

- **Runtime**: Cloudflare Workers with `nodejs_compat`. We use both Web
  standard APIs (Request/Response/fetch/streams) and Node.js APIs freely —
  Workers supports both. No need to avoid Node APIs "for portability."
- **`node:fs`**: Built into Workers — read-only `/bundle/` directory for
  bundled files, writable `/tmp/` per-request. For persistent storage,
  [`worker-fs-mount`](https://github.com/danlapid/worker-fs-mount) adds
  mount points backed by R2, Durable Objects (SQLite), or in-memory
  storage behind standard `fs.readFile`/`fs.writeFile` APIs. Libraries
  that use `node:fs` aren't automatically incompatible.
- **Caching/ISR**: Cloudflare KV is the default cache backend. The
  `KVCacheHandler` ships with vinext. HTTP cache headers
  (`Cache-Control`, `stale-while-revalidate`) work natively with
  Cloudflare's CDN.
- **Images**: Cloudflare Image Resizing is the default optimization
  backend. `@unpic/react` auto-detects it.
- **Static assets**: Served via Workers Assets (the `assets` config in
  wrangler). No separate CDN or S3 bucket needed.
- **Build output**: Vite builds the worker + client bundles.
  `@cloudflare/vite-plugin` handles the Workers-specific output format.
  `wrangler deploy` ships it.
- **Dev/prod parity**: `vinext dev` runs in `workerd` via the Cloudflare
  Vite plugin, not a Node.js approximation. What works in dev works in
  production.
- **Bindings**: KV, R2, D1, Durable Objects, Queues, AI, Vectorize
  should be accessible from `getServerSideProps`, API routes, Server
  Components, and Server Actions with minimal boilerplate.

The litmus test for every feature: **"does this work on Cloudflare
Workers?"** If it does, ship it. If it also works on Node.js, that's a
bonus we don't break gratuitously, but we don't block on it either.

`@cloudflare/vite-plugin` (310k weekly downloads) is our key dependency.
It runs code in `workerd` during dev, handles the Workers build output,
and integrates with Vite's Environment API that `@vitejs/plugin-rsc` also
uses. The two plugins compose cleanly.

## Why This Might Actually Work

- Vite already handles JSX/TSX, CSS Modules, HMR, code splitting, SSR
- **`@vitejs/plugin-rsc` exists** - official Vite team RSC plugin (v0.5.19,
  60k weekly downloads, maintained by Evan You / patak / antfu). Handles the
  entire RSC pipeline: server/client component boundaries, `'use server'` /
  `'use client'` directives, SSR streaming, HMR for server components, CSS
  code-splitting across environments. This eliminates what was previously the
  single hardest technical risk.
- Most of Next's "magic" is file-system conventions + a rendering pipeline
- The hard parts (bundling, transforms, dev server) are what Vite is best at
- Next.js's test suite is public and comprehensive - we have a concrete target
- OpenNext proves there's real demand for Next.js portability

## Architecture

Built on `@vitejs/plugin-rsc` which provides the RSC foundation (three Vite
environments: `rsc`, `ssr`, `client`). We layer Next.js conventions on top.

```
vinext
├── vinext          # Core Vite plugin
│   ├── routing/                    # File-system router (app/ and pages/ conventions)
│   │   ├── app-router.ts           # app/ directory scanning + route generation
│   │   ├── pages-router.ts         # pages/ directory scanning (legacy)
│   │   └── manifest.ts             # Route manifest generation
│   ├── entries/                    # Vite environment entry points
│   │   ├── entry.rsc.tsx           # RSC environment: routes -> React tree -> RSC stream
│   │   ├── entry.ssr.tsx           # SSR environment: RSC stream -> HTML
│   │   └── entry.browser.tsx       # Client: hydration + client-side navigation
│   ├── server/                     # Request handling
│   │   ├── dev-server.ts           # Dev server (wraps Vite dev)
│   │   ├── prod-server.ts          # Production server
│   │   ├── api-handler.ts          # route.ts handler (GET/POST/etc)
│   │   └── middleware.ts           # middleware.ts runner
│   ├── shims/                      # next/* module shims
│   │   ├── link.tsx                # next/link -> client nav component
│   │   ├── image.tsx               # next/image -> optimized image component
│   │   ├── head.tsx                # next/head -> document head
│   │   ├── navigation.ts           # next/navigation -> useRouter, usePathname, etc.
│   │   ├── headers.ts              # next/headers -> cookies(), headers()
│   │   └── server.ts               # next/server -> NextRequest, NextResponse
│   └── config/                     # next.config.js parser + transformer
│   └── cli.ts                     # `vinext dev`, `vinext build`, `vinext start`
├── test-harness/                   # Adapted Next.js e2e test runner
└── areweviteyet/                   # Progress dashboard site
```

### How `next/*` Import Shims Work

The entire shim system is built on Vite's `resolve.alias` - our plugin
registers aliases for every `next/*` import path, redirecting them to our
implementations:

```ts
// Inside vinext
resolve: {
  alias: {
    'next/link': '@vinext/shims/link',
    'next/image': '@vinext/shims/image',
    'next/router': '@vinext/shims/router',
    'next/head': '@vinext/shims/head',
    // ... every next/* import
  }
}
```

This is load-bearing for the entire project. Because alias resolution
happens at the Vite bundler level, it works for user code AND third-party
libraries. When `next-auth` does `import { NextResponse } from 'next/server'`,
it gets our shim automatically. No configuration needed from the user.

Users don't configure aliases manually. The plugin does it all. You add
`vinext()` to your `vite.config.ts` and every `next/*` import in
your entire dependency tree resolves to our implementation.

### CLI Approach

Lean into Vite rather than building a bespoke CLI. The plugin does the
heavy lifting; the CLI is just Vite with our plugin pre-configured:

- **`vite dev`** works directly if the user has our plugin in their config
- **`vinext dev`** / **`vinext build`** / **`vinext start`** are
  thin wrappers that call Vite with our plugin, so users migrating from
  Next.js have a familiar command to run without touching `vite.config.ts`
- Long-term, we want people to just think of this as a Vite app. The
  `vinext` CLI is a migration convenience, not the primary interface.

We do NOT publish a package called `next` (trademark issues, npm policy,
and it would be confusing). Users either:
1. Use the `vinext` CLI (drop-in replacement for `next` CLI), or
2. Add the plugin to their `vite.config.ts` and use `vite` directly

### How It Maps to `@vitejs/plugin-rsc`

The plugin-rsc provides three Vite environments with distinct module
resolution (e.g. `rsc` uses `react-server` condition). Our job:

- **`rsc` entry**: Scan `app/` directory, build route tree, render matched
  route to RSC stream via `renderToReadableStream`. Handle `route.ts` API
  endpoints directly.
- **`ssr` entry**: Receive RSC stream, render to HTML via `react-dom/server`.
  Inject bootstrap script for client hydration.
- **`client` entry**: Hydrate the page, handle client-side navigation
  (intercepting `<Link>` clicks, calling back to RSC endpoint for new pages).
- **CSS**: Handled automatically by plugin-rsc's `loadCss()` infrastructure.
- **HMR**: Plugin-rsc provides `rsc:update` events; we wire those to trigger
  RSC re-fetch on the client.

## API Surface Inventory

### Module Shims (what users import)

| Next.js Import | Priority | Complexity | Notes |
|---|---|---|---|
| `next/head` | P0 | Low | Document head management (Pages Router) |
| `next/link` | P0 | Medium | Client-side nav, prefetching |
| `next/router` (Pages) | P0 | High | Pages Router `useRouter` - needed first |
| `next/document` | P0 | Low | Pages Router `_document.tsx` |
| `next/app` | P0 | Low | Pages Router `_app.tsx` |
| `next/image` | P1 | Low | Shim via `@unpic/react` + `vite-imagetools` |
| `next/dynamic` | P1 | Medium | Dynamic imports / code splitting |
| `next/navigation` (App) | P1 | High | `useRouter`, `usePathname`, `useSearchParams`, `useParams`, `redirect`, `notFound` |
| `next/headers` | P1 | Medium | `cookies()`, `headers()`, `draftMode()` |
| `next/server` | P1 | Medium | `NextRequest`, `NextResponse`, `after()` |
| `next/font` | P1 | High | Font optimization (`next/font/google`, `next/font/local`) |
| `next/cache` | P1 | Medium | `revalidateTag()`, `revalidatePath()`, `unstable_cache()` |
| `next/script` | P2 | Low | Third-party script loading |
| `next/og` | P2 | Medium | OG image generation |
| `next/form` | P2 | Low | Progressive enhancement form |

### File Conventions

| Convention | Priority | Notes |
|---|---|---|
| `app/page.tsx` | P0 | Route pages |
| `app/layout.tsx` | P0 | Nested layouts |
| `app/loading.tsx` | P1 | Suspense fallback |
| `app/error.tsx` | P1 | Error boundary |
| `app/not-found.tsx` | P1 | 404 page |
| `app/global-error.tsx` | P2 | Global error boundary |
| `app/route.ts` | P0 | API route handlers |
| `app/template.tsx` | P2 | Re-mounting layout |
| `app/default.tsx` | P2 | Parallel route default |
| `[param]/` | P0 | Dynamic segments |
| `[...catchAll]/` | P1 | Catch-all segments |
| `(group)/` | P1 | Route groups |
| `@slot/` | P2 | Parallel routes |
| `(.)intercepting/` | P2 | Intercepting routes |
| `generateMetadata()` | P1 | App Router metadata/SEO (also `export const metadata`) |
| `generateStaticParams()` | P1 | App Router equivalent of `getStaticPaths` |
| `app/icon.*` | P2 | Icon routes |
| `app/apple-icon.*` | P2 | Apple icon routes |
| `app/opengraph-image.*` | P2 | Open Graph image routes |
| `app/twitter-image.*` | P2 | Twitter image routes |
| `app/robots.*` | P2 | robots.txt route |
| `app/sitemap.*` | P2 | sitemap.xml route |
| `app/manifest.*` | P2 | web manifest route |
| `pages/` directory | P0 | Pages Router - starting here |
| `pages/api/` | P0 | Pages Router API routes |
| `middleware.ts` | P2 | Runs in Node, not Edge |

### Rendering Modes

| Mode | Priority | Notes |
|---|---|---|
| SSR (Server-Side Rendering) | P0 | Basic HTML rendering |
| RSC (React Server Components) | P0 | Server/client component split |
| SSG (Static Site Generation) | P1 | Build-time rendering |
| ISR (Incremental Static Regen) | P2 | On-demand revalidation |
| Streaming SSR | P1 | HTML streaming with Suspense |
| `output: 'export'` | P1 | Full static export |

### Config (`next.config.js` / `next.config.mjs` / `next.config.ts`)

| Feature | Priority | Notes |
|---|---|---|
| `rewrites` | P1 | URL rewriting rules |
| `redirects` | P1 | Redirect rules |
| `headers` | P1 | Custom response headers |
| `basePath` | P1 | Base URL path |
| `trailingSlash` | P2 | URL normalization |
| `images` | P1 | Image optimization config |
| `i18n` | P2 | Internationalization routing |
| `env` | P0 | Environment variables (including `NEXT_PUBLIC_*` client inlining) |
| `experimental` | varies | Feature flags |

### Metadata API (App Router)

| Feature | Priority | Notes |
|---|---|---|
| `export const metadata` | P1 | Static metadata export |
| `generateMetadata` | P1 | Dynamic metadata generation |
| `viewport` | P2 | Viewport metadata |
| `themeColor` | P2 | Theme color metadata |

### Route Segment Config (App Router)

| Config | Priority | Notes |
|---|---|---|
| `dynamic` | P1 | Static vs dynamic rendering |
| `dynamicParams` | P2 | Param fallback control |
| `revalidate` | P1 | ISR controls |
| `runtime` | P2 | Runtime selection |
| `preferredRegion` | P2 | Vercel-ism; acknowledged no-op (may wire to providers later) |
| `fetchCache` | P2 | Fetch caching policy |
| `maxDuration` | P2 | Execution time hint |

## Phased Execution Plan

### Phases 0–5: COMPLETE

Pages Router, App Router, Cloudflare Workers integration, benchmarks,
production server, middleware, ISR, and more. See git history and
DISCOVERIES.md for details.

**Current state** (as of Phase 5 completion):
- 638 vitest tests, 117+ Playwright E2E tests (5 projects)
- Pages Router + App Router fully working
- Cloudflare Workers: SSR, API routes, KV cache handler
- Benchmarks: 7x faster builds, 55% smaller bundles vs Next.js 16

### Phase 6: Client Hydration on Workers

**Goal**: Full client-side interactivity on Cloudflare Workers. This is
the #1 blocker — without it, Workers-deployed apps are SSR-only.

- [ ] Multi-environment build for Workers: client JS bundles alongside
  worker bundle. The `@cloudflare/vite-plugin` currently only builds the
  worker environment. Need to coordinate client bundle output with
  Workers Assets serving.
- [ ] Pages Router hydration: `__NEXT_DATA__` + client entry + React
  hydrate in the browser, served via Workers Assets
- [ ] App Router hydration: RSC stream + client entry (already works in
  Node dev, need to verify on Workers build)
- [ ] Client-side navigation works end-to-end on Workers (Link, router.push)
- [ ] E2E tests for hydration + interactivity on Workers
- [ ] **Validation**: Interactive app (form submission, client state, navigation)
  works on `wrangler dev` and `wrangler deploy`

### Phase 7: `vinext deploy` — One-Command Cloudflare Deployment

**Goal**: `vinext deploy` takes any Next.js app from zero to deployed on
Cloudflare Workers with no manual configuration.

- [ ] **`vinext deploy` command**: Runs `vite build` + `wrangler deploy`
  in sequence. Handles all intermediate steps.
- [ ] **Auto-generate `wrangler.jsonc`**: If no wrangler config exists,
  generate one with sensible defaults (`compatibility_date`, `nodejs_compat`,
  `assets` config for static files).
- [ ] **Auto-generate worker entry**: If no `worker/index.ts` exists,
  generate the appropriate entry based on detected router (App Router vs
  Pages Router). No boilerplate needed from the user.
- [ ] **Auto-detect Cloudflare plugin**: If `@cloudflare/vite-plugin` isn't
  in the project, prompt to install it (or auto-install with consent).
- [ ] **Auto-configure RSC plugin**: For App Router, ensure
  `@vitejs/plugin-rsc` is configured with the right entries.
- [ ] **KV namespace setup**: If ISR/caching is detected (`revalidate`
  in any page), auto-create a KV namespace and wire the `KVCacheHandler`.
- [ ] **Static assets**: Configure Workers Assets to serve `public/` and
  client build output.
- [ ] **Environment variables**: Read from `.env` / `.env.local` and set
  as wrangler secrets (or prompt the user).
- [ ] **`vinext deploy --preview`**: Deploy to a preview URL for testing.
- [ ] **`vinext deploy --production`**: Deploy to production.
- [ ] **Validation**: Fresh Next.js app → `npm install vinext` →
  `vinext deploy` → working URL on workers.dev in under 60 seconds.

### Phase 8: Cloudflare Platform Integration

**Goal**: Cloudflare's platform capabilities (KV, R2, D1, DO, AI, Queues)
are trivially accessible from Next.js server code. This is the "better
than anywhere else" differentiator.

- [ ] **Bindings access pattern**: Define how `getServerSideProps`, API
  routes, Server Components, and Server Actions access `env` bindings.
  Options: (a) `getCloudflareContext()` helper, (b) extend the existing
  request context, (c) AsyncLocalStorage-based injection.
- [ ] **KV**: Available in server code for caching, session storage, config.
- [ ] **R2**: Available for file uploads, asset storage, user content.
- [ ] **D1**: Available for database queries from server code.
- [ ] **Durable Objects**: Available for stateful server-side logic
  (collaborative editing, WebSockets, rate limiting).
- [ ] **Workers AI**: Available for inference from server code.
- [ ] **Queues**: Available for background job processing from Server Actions.
- [ ] **`node:fs` with persistent mounts**: Document and support
  [`worker-fs-mount`](https://github.com/danlapid/worker-fs-mount) for
  persistent filesystem backed by R2 or Durable Objects. Libraries that
  depend on `node:fs` for file I/O can work with real persistent storage.
- [ ] **Validation**: Example app using KV + R2 + D1 from
  getServerSideProps/API routes/Server Components.

### Phase 9: Developer Experience Polish

**Goal**: Production-ready DX. Migration is smooth, errors are helpful,
the workflow feels native.

- [ ] **`vinext dev` defaults to workerd**: Use `@cloudflare/vite-plugin`
  by default so dev runs in the Workers runtime, not Node.js. True
  dev/prod parity.
- [ ] **`vinext check`**: Compatibility scanner — point at a Next.js app,
  get a report of what works, what needs changes, and what's unsupported.
- [ ] **`vinext migrate`**: Automated codemods for common migration
  patterns (import rewrites, config translation, etc.).
- [ ] **Error messages**: When something fails on Workers, the error
  should explain the Workers-specific context (e.g., "this API isn't
  available in Workers — use KV instead of fs.writeFile for persistent
  storage, or use worker-fs-mount for a drop-in fs replacement").
- [ ] **Cloudflare dashboard integration**: Link to the deployed Worker
  in the Cloudflare dashboard after `vinext deploy`.
- [ ] **ISR E2E tests** (issue #8)
- [ ] **`"use cache"` directive** — implement or integrate with
  Cloudflare's caching layer
- [ ] **Are We Vite Yet?** dashboard live and auto-updating

### Phase 10: Scale & Ecosystem

**Goal**: Real-world apps migrate successfully. Third-party ecosystem works.

- [ ] **Ecosystem library testing**: Top Next.js libraries work on vinext +
  Workers (next-intl, next-themes, next-auth, @clerk/nextjs, nuqs, etc.)
- [ ] **Large app validation**: Test with 100+ page apps, monorepos
- [ ] **Performance at scale**: Cold start, memory usage, response time
  under real traffic patterns on Workers
- [ ] **Documentation site**: Full docs for vinext + Cloudflare workflow
- [ ] **PPR (Partial Prerendering)**: Implement if/when Next.js 16
  stabilizes the API (now "Cache Components")

### Benchmarks (Phase 5 — COMPLETE)

Results from Phase 5, retained for reference:

| Metric | Next.js 16 (Turbopack) | vinext (Rollup) | vinext (Rolldown) |
|--------|----------------------|-----------------|-------------------|
| Production build | 6.59s | 2.43s (2.7x faster) | 946ms (7.0x faster) |
| Client bundle (gzip) | 168.9 KB | 75.4 KB (55% smaller) | 73.8 KB (56% smaller) |
| Dev cold start | 2.20s | 1.37s (1.6x faster) | 1.21s (1.8x faster) |

Future benchmarks should compare Workers-deployed vinext vs Vercel-deployed
Next.js (TTFB, cold start, global latency) — that's the real comparison
users care about.

## Test Harness Strategy

This is the key innovation. Next.js has ~460+ e2e test suites. The plan:

### Extraction

1. Clone `vercel/next.js` repo
2. Extract `test/e2e/`, `test/development/`, `test/production/` directories
3. Extract `test/lib/` (test utilities, `nextTestSetup`, browser helpers)
4. Extract fixture apps embedded alongside each test

### Adaptation

The tests use `nextTestSetup()` which:
1. Copies fixture files to a temp directory
2. Installs dependencies
3. Starts a Next.js server on a random port
4. Provides `next.render()`, `next.fetch()`, `next.browser()` APIs
5. Cleans up after tests

**We need to replace step 3**: instead of starting `next dev`/`next start`,
start our Vite-based server. The rest of the test infrastructure
(`render`, `fetch`, `browser` via Playwright) works unchanged.

Concretely:
- Fork `NextInstance` base class
- Create `ViteNextInstance` that calls our plugin instead of `next`
- The test assertions stay identical - they don't care what's serving the HTML

### Runtime Contract Black-Box Suite (New)

We add a separate, minimal, request/response-only test suite that runs against
both **real Next.js** and **vinext** with identical fixtures. The tests are
black-box: they spin up a server and only assert on HTTP behavior (status,
headers, body, redirects, cookies, cache headers) with no internal hooks.

Why: this catches subtle runtime differences without depending on Next.js
internals or build output. It becomes the contract for:
- `NextRequest`/`NextResponse` semantics
- `redirect()`/`notFound()` behavior
- `cookies()`/`headers()` behavior
- `fetch` caching, `revalidate`, `no-store`
- `basePath`/`i18n`/`trailingSlash` routing

### Third-Party Integration Test Pack (Ecosystem Tests)

We add a curated set of real-world integrations as black-box tests, each with
a minimal fixture app under `fixtures/ecosystem/`. These run separately from
the main test suite (`npm run test:ecosystem`) because they require installing
third-party dependencies and some need API tokens.

#### Tier 1: No credentials needed (run in CI)

| Library | What to test | Status |
|---|---|---|
| `next-intl` | App Router + Pages Router i18n, `useTranslations`, `NextIntlClientProvider`, middleware locale detection | TODO |
| `next-themes` | Theme provider, `useTheme`, SSR class injection, `suppressHydrationWarning` | TODO |
| `next-mdx-remote` | Remote MDX rendering, custom components, RSC serialization | TODO |
| `next-view-transitions` | `ViewTransitions` provider, `Link` wrapping, `useTransitionRouter` | TODO |
| `nextjs-toploader` | NProgress bar, App Router integration, route change events | TODO |
| `next-nprogress-bar` | Similar to toploader, App Router `useRouter` events | TODO |
| `nuqs` | URL search params state management, `useQueryState`, shallow updates | TODO |
| `next-safe-action` | Type-safe server actions, `useAction`, validation | TODO |

#### Tier 2: Credentials required (run manually or in CI with secrets)

| Library | What to test | Credentials needed | Status |
|---|---|---|---|
| `@clerk/nextjs` | `ClerkProvider`, `SignIn`/`SignUp` components, `auth()` in server components, middleware auth | Clerk publishable key + secret key | TODO |
| `@sentry/nextjs` | Error boundary reporting, `Sentry.init`, source maps, `withSentry` wrapper, RSC error tracking | Sentry DSN | TODO |
| `next-auth` / `auth.js` | OAuth providers, session management, `getServerSession`, middleware auth | OAuth client credentials | TODO |

#### Implementation plan

Each ecosystem fixture is a self-contained mini-app:

```
fixtures/ecosystem/
  next-intl/
    package.json          # deps: next-intl, react, react-dom
    vite.config.ts        # uses vinext
    app/
      layout.tsx
      [locale]/
        page.tsx
    messages/
      en.json
      de.json
  next-themes/
    ...
  clerk-auth/
    ...
```

Test runner approach:
1. Each fixture has its own `package.json` with the library as a dependency
2. `npm run test:ecosystem` installs deps, starts dev server, runs assertions
3. Tests use Playwright or plain fetch to verify SSR output and client behavior
4. Tier 2 tests are skipped if env vars are missing (e.g., `CLERK_SECRET_KEY`)
5. Results feed into the "Are We Vite Yet?" compatibility matrix

Key things each fixture validates:
- **Import resolution**: Library can `import` from `next/*` without errors
- **SSR rendering**: Server-rendered HTML includes expected library output
- **Client hydration**: No hydration mismatch warnings in console
- **Runtime behavior**: Interactive features work (auth flows, theme switching, etc.)

#### What we already shim for these libraries

- `next/dist/shared/lib/app-router-context.shared-runtime` — used by @clerk/nextjs, next-intl, next-nprogress-bar, nextjs-toploader, next-view-transitions (type-only imports)
- `next/dist/shared/lib/utils` — `execOnce`, `getLocationOrigin`, `getURL`
- `next/dist/server/web/spec-extension/cookies` — `RequestCookies`, `ResponseCookies`
- `next/dist/server/api-utils` — type-only re-exports
- `next/dist/server/app-render/work-unit-async-storage.external` — `AsyncLocalStorage` instances (used by @sentry/nextjs)

### Iteration Loop ("Ralph Wiggum Style")

```
while (failing_tests > 0):
    pick the simplest failing test
    understand what Next.js API it exercises
    implement that API in vinext
    run test again
    if passes: commit, pick next test
    if still fails: debug, fix, repeat
```

### Progress Dashboard: "Are We Vite Yet?"

Inspired by Vercel's [areweturboyet.com](https://areweturboyet.com/) - their
public dashboard tracking Turbopack's pass rate against Next.js's own test
suite. They were asking "is Turbopack ready to replace Webpack inside Next?"
We're asking the inverse: "is Vite ready to replace all of Next?"

We build the same thing: a public site (areweviteyet.com) that:

- Shows a single headline pass rate (e.g. "37% of Next.js e2e tests passing")
- Breaks down by category with progress bars:
  - App Router: 45/365 passing
  - Pages Router: 12/120 passing
  - Middleware: 0/30 passing
  - Production: 8/30 passing
  - Development/HMR: 3/30 passing
- Color-coded: green (passing), red (failing), gray (skipped/not applicable)
- Links each test to its source so contributors can pick one and work on it
- Auto-updates from CI on every commit (run the full suite nightly or on PR)

This serves double duty: progress tracking for us, and a public signal to the
community that this is a serious effort with measurable, transparent progress.
It also makes contribution dead simple - find a red test, make it green.

### Test Categories to Prioritize

1. `test/e2e/pages-dir/` - Pages Router (starting here)
2. `test/integration/` - Legacy tests (many are Pages Router)
3. `test/production/` - Production build correctness
4. `test/e2e/app-dir/` - App Router (Phase 2+)
5. `test/development/` - Dev server / HMR
6. `test/e2e/middleware-general/` - Middleware (Phase 3)

## Decisions Made

1. ~~**RSC bundling**~~ **RESOLVED**: `@vitejs/plugin-rsc` (official Vite
   plugin) handles the full RSC pipeline. It provides three environments
   (`rsc`, `ssr`, `client`), handles `'use server'`/`'use client'` directive
   boundaries, RSC stream serialization/deserialization, CSS code-splitting
   across server/client, and HMR for server components. We build on top of
   this rather than rolling our own. It even supports `"use cache"` already.

2. ~~**Scope of Pages Router support**~~ **RESOLVED: Pages Router first.**
   It's simpler (no RSC, no server/client component boundaries), it's what
   a lot of people are still stuck on, and Vercel has effectively abandoned
   it. Those users are the most locked-in and the most motivated to migrate.
   Starting here gives us a working system faster and builds momentum before
   tackling the harder App Router + RSC surface.

3. ~~**`next/image` optimization**~~ **RESOLVED: Shim over existing tools.**
   No point rebuilding Sharp pipelines. Use:
   - **`@unpic/react`** (40k weekly downloads) as the component layer. This
     is **provider-agnostic by design** - it auto-detects the image CDN from
     the URL and uses that CDN's native resizing. 28 providers supported:
     Cloudflare, Netlify, Vercel, IPX (self-hosted), Cloudinary, Imgix,
     Shopify, Bunny.net, etc. Has a `fallback` prop so you can configure
     per-deployment target (e.g. `fallback="cloudflare"` on CF,
     `fallback="ipx"` on self-hosted). This actually aligns perfectly with
     the deploy-anywhere goal - wherever you deploy, unpic uses whatever
     image CDN is available there natively.
   - **`vite-imagetools`** (109k weekly downloads) for **local images** that
     aren't on a CDN. Sharp-powered build-time optimization (resize, format
     conversion, srcset generation). Images are optimized at build time so
     no runtime image processing needed on the server.
   This is arguably a *better* story than `next/image`, which forces
   everything through Vercel's optimizer or requires you to configure a
   single loader manually.

4. ~~**Edge Runtime**~~ **RESOLVED: Workers IS the runtime.** Since
   Cloudflare Workers is the primary target, everything — middleware,
   SSR, API routes, Server Components — runs in `workerd` natively.
   This is actually a simpler model than Node.js: one runtime, globally
   distributed, with Web standard APIs + `nodejs_compat`.

5. **Turbopack-specific behaviors**: Treating the public API as the contract.
   If a behavior only exists because of Turbopack internals, it's not part
   of the compatibility target.

6. ~~**Build output format**~~ **RESOLVED: Emit our own structure.** We do
   NOT need `.next/` directory compatibility. The entire point is that we
   don't need OpenNext adapters or Vercel-specific tooling to deploy. Our
   build output is standard Vite output. If a post-build tool expects
   `.next/server/pages-manifest.json`, that tool is part of the problem
   we're solving.

7. **Third-party library compatibility**: This is a known hard problem.
   Libraries like `next-auth`, `@clerk/nextjs`, `@sentry/nextjs`,
   `next-intl`, `next-themes`, `next-sitemap` etc. often import from
   `next/*` internals or use Next.js plugin hooks. Strategy:
   - Maintain a **compatibility tracker** (part of the Are We Vite Yet?
     dashboard) for the top 50 most-used Next.js ecosystem packages
   - For libraries that import from public `next/*` APIs only: our shims
     handle it automatically
   - For libraries that reach into `next/dist/...` internals: document
     on a per-library basis, contribute upstream PRs where possible, or
     provide wrapper packages (`@vinext/auth`, etc.) as a last resort
   - The `npx vinext check` tool flags these before migration
   - Tackle these reactively as real users hit them, don't try to
     pre-solve every library

8. ~~**`next/image` prop API translation**~~ **DEFERRED.** `next/image`
   and `@unpic/react` have different prop APIs (`fill` vs `layout`,
   `placeholder="blur"` + `blurDataURL`, `quality`, custom `loader`,
   etc.). The shim layer translating Next.js image props to unpic is
   non-trivial. Will tackle when we get to image support in Phase 1,
   likely by writing a thin wrapper component that maps the props.

9. ~~**Monorepo / Turborepo support**~~ **DEFERRED.** Many Next.js apps
   live in monorepos with shared packages and `transpilePackages` config.
   Vite handles monorepos well natively, but Next.js-specific patterns
   (Turborepo caching, `transpilePackages`) need investigation. Punt to
   Phase 3+ once single-app compat is solid.

## Compatibility Matrix

Published matrix tracking per-feature status against latest Next.js (16.x):

- Module shims (next/*) with behavior notes
- File conventions and metadata routes
- Rendering modes and cache semantics
- Config flags and routing behavior
- Third-party integration tests

Part of the docs and surfaced by `vinext status` CLI command.

## Routing Behavior Spec (Later)

Deprioritized. A formal routing spec will emerge naturally from the test
harness work and black-box contract tests rather than being written
upfront. We'll codify it once we've learned enough from implementation.

## Non-Goals (Explicit)

- **Generic multi-platform deployment** — AWS, Netlify, Fly.io, generic
  Node.js servers are not targets. If vinext happens to work there because
  we use standard APIs, fine. But we won't spend engineering effort on
  non-Cloudflare deployment paths or maintain adapters for other platforms.
- **Node.js production server as primary** — `vinext start` exists for
  local testing convenience, but the real production target is Workers.
  We won't optimize Node.js server performance or add Node-specific
  production features.
- **Canary-only Next.js features** and unstable internal flags
- **Undocumented SWC/Turbopack behaviors**
- **Vercel-specific infrastructure** (Vercel's image optimizer, their
  edge network, their caching layer, their serverless format)

## Remaining Open Questions

1. **Name**: Going with `vinext` for now. Clear, obvious, descriptive.
   Open to change if something better emerges.

## Success Criteria

- **Phases 0–5**: DONE. Full Pages + App Router, Workers integration, benchmarks.
- **Phase 6**: Interactive apps work on Workers (client hydration, navigation, state).
- **Phase 7**: `vinext deploy` takes a Next.js app to a workers.dev URL in one command.
- **Phase 8**: Cloudflare bindings (KV, R2, D1, AI) accessible from Next.js server code.
- **Phase 9**: Smooth migration DX. `vinext check` reports compat. Helpful error messages.
- **Phase 10**: Real-world apps migrate. Ecosystem libraries work. Production-ready.

## Prior Art & References

- [OpenNext](https://opennext.js.org/) - Deploy Next.js anywhere (AWS/Cloudflare/Netlify adapters). Proves demand but demonstrates the fragility of adapter-based approaches.
- [`@vitejs/plugin-rsc`](https://www.npmjs.com/package/@vitejs/plugin-rsc) - Official Vite RSC plugin. Our foundation.
- [`@cloudflare/vite-plugin`](https://www.npmjs.com/package/@cloudflare/vite-plugin) - Cloudflare Workers Vite plugin (310k weekly downloads). Compatible with plugin-rsc via Environment API.
- [`worker-fs-mount`](https://github.com/danlapid/worker-fs-mount) - Mount WorkerEntrypoints as virtual filesystems. Backends: R2, Durable Objects (SQLite), in-memory.
- [Cloudflare `node:fs` docs](https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/) - Built-in VFS: `/bundle/` (read-only), `/tmp/` (per-request writable), `/dev/*` devices.
- [`vite-imagetools`](https://www.npmjs.com/package/vite-imagetools) - Sharp-powered image optimization for Vite (109k weekly downloads)
- [`@unpic/react`](https://www.npmjs.com/package/@unpic/react) - Universal image component, auto-detects CDNs including Cloudflare Image Resizing (40k weekly downloads)
- [Vike](https://vike.dev/) - Vite-based SSR framework (different API)
- [Waku](https://waku.gg/) - Minimal RSC framework on Vite
- [Are We Turbo Yet?](https://areweturboyet.com/) - Vercel's Turbopack progress tracker. Inspiration for our dashboard.
- Next.js repo: https://github.com/vercel/next.js
- Existing POC: AI chatbot example (internal, built by team member)
