# nextcompat: Next.js API Surface Reimplemented on Vite

## Thesis

Next.js has become the dominant React meta-framework, but its internals are a
mess - bespoke compiler (SWC fork), Turbopack, custom HMR protocol, enormous
dependency surface. Meanwhile, Vite has won the build tooling war and become
the de facto standard. The question: **can we reimplement the Next.js API
surface - file conventions, routing, data fetching, rendering - as a Vite
plugin?**

Not a "Vite-flavored alternative." A direct, API-compatible reimplementation
where existing Next.js apps can `npm uninstall next && npm install nextcompat`
and largely Just Work.

## Why This Matters: The Deployment Problem

Next.js is effectively locked to Vercel. Running it anywhere else is a
nightmare. The [OpenNext](https://opennext.js.org/) project exists solely to
bridge this gap, with separate adapters maintained by different teams:

- **AWS adapter** (maintained by SST community)
- **Cloudflare adapter** (maintained by Cloudflare team)
- **Netlify adapter** (maintained by Netlify team)

Each adapter is constantly chasing Next.js updates, reimplementing internal
behaviors that Vercel changes without notice. NHS England, Udacity, Gymshark
all use OpenNext because there's no other option.

**If we rebuild on Vite, this problem disappears.** Vite's ecosystem already
has deployment adapters everywhere. The build output is standard, portable,
and understood by every hosting platform. No more reverse-engineering Vercel's
proprietary server runtime. A Next.js-compatible app built on Vite deploys
anywhere Vite deploys - which is everywhere.

This is arguably the strongest practical motivation: not just cleaner
internals, but **liberating Next.js apps from vendor lock-in**.

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
nextcompat
├── vite-plugin-nextcompat          # Core Vite plugin
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
├── nextcompat-cli                  # `nextcompat dev`, `nextcompat build`, `nextcompat start`
├── test-harness/                   # Adapted Next.js e2e test runner
└── areweviteyet/                   # Progress dashboard site
```

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
| `next/font` | P2 | High | Font optimization |
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
| `app/route.ts` | P0 | API route handlers |
| `app/template.tsx` | P2 | Re-mounting layout |
| `app/default.tsx` | P2 | Parallel route default |
| `[param]/` | P0 | Dynamic segments |
| `[...catchAll]/` | P1 | Catch-all segments |
| `(group)/` | P1 | Route groups |
| `@slot/` | P2 | Parallel routes |
| `(.)intercepting/` | P2 | Intercepting routes |
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

### Config (`next.config.js`)

| Feature | Priority | Notes |
|---|---|---|
| `rewrites` | P1 | URL rewriting rules |
| `redirects` | P1 | Redirect rules |
| `headers` | P1 | Custom response headers |
| `basePath` | P1 | Base URL path |
| `trailingSlash` | P2 | URL normalization |
| `images` | P1 | Image optimization config |
| `i18n` | P2 | Internationalization routing |
| `env` | P0 | Environment variables |
| `experimental` | varies | Feature flags |

## Phased Execution Plan

### Phase 0: Pages Router Foundation (Week 1-2)

**Goal**: Simplest Pages Router app renders. Start with the easier,
well-understood model before tackling RSC.

- [ ] Scaffold the Vite plugin structure (on top of `@vitejs/plugin-rsc`)
- [ ] Implement `pages/` directory file-system routing
  - Page discovery and route generation
  - Dynamic route segments `[param]`
  - `_app.tsx`, `_document.tsx` support
- [ ] Implement basic SSR rendering pipeline
  - Server-side React rendering to HTML
  - Client hydration bundle generation
- [ ] Implement `next/head` shim
- [ ] Implement `next/link` shim (basic - renders `<a>` with client nav)
- [ ] Implement `next/router` shim (`useRouter`, `router.push`, etc.)
- [ ] Create CLI: `nextcompat dev` wrapping `vite dev` with our plugin
- [ ] **Validation**: `reproduction-template-pages` and `with-typescript`
  examples render and navigate

### Phase 1: Pages Router Complete + Production (Week 3-5)

**Goal**: Full Pages Router compat. Production builds. Test harness online.

- [ ] `getServerSideProps` (server-side data fetching per request)
- [ ] `getStaticProps` + `getStaticPaths` (static generation)
- [ ] `pages/api/` routes (API endpoints)
- [ ] `_error.tsx`, `404.tsx`, `500.tsx` (error pages)
- [ ] `next/dynamic` (dynamic imports / code splitting)
- [ ] `next/image` shim (via `@unpic/react` + `vite-imagetools` for local)
- [ ] CSS Modules support (Vite handles natively)
- [ ] `next.config.js` parsing (basic: `env`, `basePath`, `rewrites`,
  `redirects`, `headers`)
- [ ] `nextcompat build` (production build via `vite build`)
- [ ] `nextcompat start` (production server)
- [ ] **Validation**: `api-routes-rest`, `api-routes-cors`, `with-docker`
- [ ] **Test harness**: Extract and adapt Next.js e2e test infrastructure
- [ ] **Test harness**: Begin running Pages Router e2e tests, track pass rate

### Phase 2: App Router (Week 6-9)

**Goal**: App Router basics work. RSC rendering online.

- [ ] Implement `app/` directory file-system routing
  - `page.tsx` and `layout.tsx` discovery
  - Dynamic route segments `[param]`
- [ ] RSC support (server/client component boundary via `'use client'`)
  - Wire up `@vitejs/plugin-rsc` environments (rsc/ssr/client entries)
- [ ] `app/route.ts` API route handlers (GET, POST, etc.)
- [ ] `next/navigation` hooks (`useRouter`, `usePathname`, `useSearchParams`)
- [ ] `next/headers` (`cookies()`, `headers()`)
- [ ] `next/server` (`NextRequest`, `NextResponse`)
- [ ] `app/loading.tsx` (Suspense boundaries)
- [ ] `app/error.tsx` (Error boundaries)
- [ ] `app/not-found.tsx`
- [ ] Server Actions (`'use server'`)
- [ ] **Validation**: `hello-world`, `basic-css`, `next-forms` examples
- [ ] **Test harness**: Begin running App Router e2e tests

### Phase 3: Advanced Features (Week 10-13)

**Goal**: Majority of e2e tests passing across both routers.

- [ ] Middleware (`middleware.ts`) - running in Node, not Edge
- [ ] Streaming SSR
- [ ] `next/font` optimization
- [ ] Route groups, catch-all routes, optional catch-all
- [ ] `output: 'export'` (static export)
- [ ] ISR (Incremental Static Regeneration)
- [ ] `next/og` (OG image generation)
- [ ] `next/script`
- [ ] `next/form`
- [ ] Full `next.config.js` compatibility
- [ ] **Validation**: Target 50%+ of e2e test suite passing
- [ ] **Are We Vite Yet?** dashboard live and auto-updating

### Phase 4: Parity Push (Week 14+)

**Goal**: Maximize e2e test pass rate. Production-ready.

- [ ] Parallel routes (`@slot`)
- [ ] Intercepting routes
- [ ] i18n routing
- [ ] Performance optimization (bundle size, cold start, HMR speed)
- [ ] Deployment guides (Cloudflare, AWS, Netlify, Fly, Railway, etc.)
- [ ] **Validation**: Target 80%+ of e2e test suite passing

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

### Iteration Loop ("Ralph Wiggum Style")

```
while (failing_tests > 0):
    pick the simplest failing test
    understand what Next.js API it exercises
    implement that API in nextcompat
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

4. ~~**Edge Runtime**~~ **RESOLVED: Skip it. Run middleware in Node.**
   Vercel has effectively abandoned the Edge Runtime too. Middleware runs
   in Node with the standard Node APIs. Minor behavioral differences
   (e.g. no `crypto.subtle` by default) are acceptable and can be polyfilled
   if needed. This massively simplifies the implementation.

5. **Turbopack-specific behaviors**: Treating the public API as the contract.
   If a behavior only exists because of Turbopack internals, it's not part
   of the compatibility target.

## Remaining Open Questions

1. **Name**: Going with `nextcompat` for now. Clear, obvious, descriptive.
   Open to change if something better emerges.

## Success Criteria

- **Phase 0**: Pages Router hello-world renders. Basic routing works.
- **Phase 1**: Full Pages Router compat. Production builds. `getServerSideProps`/`getStaticProps`/API routes all work.
- **Phase 2**: App Router basics work. RSC renders. Server Actions function.
- **Phase 3**: 50%+ of Next.js e2e tests pass. Are We Vite Yet? dashboard live.
- **Phase 4**: 80%+ pass rate. Real-world apps can migrate. Deploy-anywhere guides.

## Prior Art & References

- [OpenNext](https://opennext.js.org/) - Deploy Next.js anywhere (AWS/Cloudflare/Netlify adapters). Proves demand for portability.
- [`@vitejs/plugin-rsc`](https://www.npmjs.com/package/@vitejs/plugin-rsc) - Official Vite RSC plugin. Our foundation.
- [`vite-imagetools`](https://www.npmjs.com/package/vite-imagetools) - Sharp-powered image optimization for Vite (109k weekly downloads)
- [`@unpic/react`](https://www.npmjs.com/package/@unpic/react) - Universal image component, auto-detects CDNs (40k weekly downloads)
- [Vike](https://vike.dev/) - Vite-based SSR framework (different API)
- [Vinxi](https://vinxi.vercel.app/) - Framework-agnostic server layer on Vite/Nitro
- [TanStack Start](https://tanstack.com/start) - Full-stack React on Vite (different API)
- [Waku](https://waku.gg/) - Minimal RSC framework on Vite
- [Are We Turbo Yet?](https://areweturboyet.com/) - Vercel's Turbopack progress tracker. Inspiration for our dashboard.
- Next.js repo: https://github.com/vercel/next.js
- Next.js e2e tests: `test/e2e/`, especially `test/e2e/app-dir/`
- Existing POC: AI chatbot example (internal, built by team member)
