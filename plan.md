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
- **Codemods** (`npx nextcompat migrate`) that automatically transform
  code away from unsupported patterns. If we can't support a pattern, we
  can at least automate the migration off of it.
- **AI-assisted migration**: For edge cases that are too contextual for
  a mechanical codemod, use an LLM that understands both the Next.js API
  surface and the nextcompat surface. `npx nextcompat migrate` scans the
  project, flags incompatibilities, and offers AI-suggested fixes in
  context - not generic "here's the docs" but actual code changes specific
  to the user's file. Mechanical transforms (rename an import, swap an
  API call) use traditional codemods. Anything that requires understanding
  intent or refactoring a pattern gets the AI treatment.
- **Runtime warnings** when we detect usage of an unsupported API, pointing
  to the docs for the recommended alternative

**Before you even migrate, we tell you what to expect:**
- **`npx nextcompat check`** - point it at an existing Next.js app and it
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
then migrate to nextcompat. One moving target is enough.

We can always broaden version support later once the core is solid. Starting
narrow keeps the scope sane.

**Deprecation policy:** If Next.js has explicitly deprecated an API, we
don't implement it. `getInitialProps`, legacy `<Image>` from `next/legacy/image`,
`next/amp`, etc. - skip them. If someone's app uses deprecated APIs, step one
is upgrading to current Next.js APIs (which they should do regardless), then
migrating to nextcompat.

## Design Principle: Deploy Anywhere by Default

This is the guiding principle behind every implementation decision.

Vercel optimizes for Vercel. Every feature they build assumes their
infrastructure - their image optimizer, their edge network, their serverless
runtime, their caching layer. If you're not on Vercel, you're an
afterthought. The result is that the entire OpenNext project exists just to
reverse-engineer Vercel's assumptions.

**We do the opposite.** We build on Vite, whose output is standard and
portable. Every feature we implement must work everywhere out of the box,
with zero provider-specific configuration:

- **Images**: Auto-detect the CDN, use its native transforms. No hardwired
  optimizer. Works on Cloudflare, Netlify, AWS, self-hosted, whatever.
- **Server runtime**: Target standard Web APIs (Request/Response, fetch,
  streams, crypto) that work across Node.js, Cloudflare Workers, Deno, and
  other WinterCG-compatible runtimes. No proprietary serverless format. If
  your runtime speaks Web standards, nextcompat runs on it.
- **Build output**: Standard Vite build artifacts. Static assets are static
  assets. Server code is server code. No proprietary `.nft.json` trace files,
  no Vercel-specific routing manifests.
- **Caching/ISR**: Use standard HTTP caching semantics (Cache-Control,
  stale-while-revalidate) that every CDN and runtime understands, not a
  proprietary revalidation protocol tied to a specific vendor.
- **Middleware**: Runs on standard Web APIs. Works the same on every
  platform - Node, Workers, Deno, anywhere.

The litmus test for every feature: **"does this work on a \$5 VPS *and*
on Cloudflare Workers?"** If it requires Node-specific APIs where a Web
standard exists, we're doing it wrong. If it requires a specific hosting
provider's infrastructure, we're doing it wrong.

This is what Vite gives us for free. Vite doesn't care where you deploy.
The ecosystem of Vite plugins already handles platform-specific deployment:

- **`@cloudflare/vite-plugin`** (310k weekly downloads) - runs code in
  `workerd` during dev for production-identical behavior on Workers. Uses
  the same Vite Environment API that `@vitejs/plugin-rsc` is built on,
  and the RSC plugin explicitly supports it via `loadModuleDevProxy`.
- **Netlify, Vercel, AWS** - standard Vite build output already works
  with their existing deployment tooling.
- **Any Node.js host** - `vite build` produces a standard server bundle.

Our job is to produce standard Vite output. The platform plugins handle the
rest. We never write provider-specific code.

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

### How `next/*` Import Shims Work

The entire shim system is built on Vite's `resolve.alias` - our plugin
registers aliases for every `next/*` import path, redirecting them to our
implementations:

```ts
// Inside vite-plugin-nextcompat
resolve: {
  alias: {
    'next/link': '@nextcompat/shims/link',
    'next/image': '@nextcompat/shims/image',
    'next/router': '@nextcompat/shims/router',
    'next/head': '@nextcompat/shims/head',
    // ... every next/* import
  }
}
```

This is load-bearing for the entire project. Because alias resolution
happens at the Vite bundler level, it works for user code AND third-party
libraries. When `next-auth` does `import { NextResponse } from 'next/server'`,
it gets our shim automatically. No configuration needed from the user.

Users don't configure aliases manually. The plugin does it all. You add
`nextcompat()` to your `vite.config.ts` and every `next/*` import in
your entire dependency tree resolves to our implementation.

### CLI Approach

Lean into Vite rather than building a bespoke CLI. The plugin does the
heavy lifting; the CLI is just Vite with our plugin pre-configured:

- **`vite dev`** works directly if the user has our plugin in their config
- **`nextcompat dev`** / **`nextcompat build`** / **`nextcompat start`** are
  thin wrappers that call Vite with our plugin, so users migrating from
  Next.js have a familiar command to run without touching `vite.config.ts`
- Long-term, we want people to just think of this as a Vite app. The
  `nextcompat` CLI is a migration convenience, not the primary interface.

We do NOT publish a package called `next` (trademark issues, npm policy,
and it would be confusing). Users either:
1. Use the `nextcompat` CLI (drop-in replacement for `next` CLI), or
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
- [ ] `NEXT_PUBLIC_*` environment variable convention: inline into client
  bundle at build time, keep everything else server-only
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
- [ ] Metadata API (`export const metadata`, `generateMetadata()`)
- [ ] `generateStaticParams()` (static generation for App Router)
- [ ] `next/font` (`next/font/google`, `next/font/local`)
- [ ] **Validation**: `hello-world`, `basic-css`, `next-forms` examples
- [ ] **Test harness**: Begin running App Router e2e tests

### Phase 3: Advanced Features (Week 10-13)

**Goal**: Majority of e2e tests passing across both routers.

- [ ] Middleware (`middleware.ts`) - running in Node, not Edge
- [ ] Streaming SSR
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

### Phase 5: Benchmarks — nextcompat vs Next.js+Turbopack

**Goal**: Quantify the developer experience and production performance advantage of nextcompat (Vite) over Next.js (Turbopack/webpack). Provide hard numbers for the README and migration guides.

#### What to benchmark

| Metric | What it measures | Why it matters |
|--------|-----------------|----------------|
| **Dev server cold start** | Time from `npm run dev` to first request served | First impression, CI/CD feedback loops |
| **HMR latency** | Time from file save to update visible in browser | Inner development loop speed |
| **Production build time** | Full `build` command, cold cache | CI/CD pipeline cost |
| **Production bundle size** | Total JS + CSS output (gzipped) | Page load speed, bandwidth cost |
| **SSR response time** | Time to first byte (TTFB) for server-rendered pages | User-facing performance |
| **Memory usage** | Peak RSS during dev and build | Feasibility on small VPS / CI runners |

#### Configurations to compare

1. **Next.js + Turbopack (dev)** — `next dev` (Turbopack is now the default dev bundler in Next.js 15+; opt out with `--no-turbopack`)
2. **Next.js + webpack (build)** — `next build` (Turbopack for production builds is not yet stable)
3. **nextcompat + Vite (Rollup/esbuild)** — current stable Vite stack (Vite 7, Rollup for production, esbuild for dev transforms)
4. **nextcompat + Vite (Rolldown)** — experimental Rust-based bundler being integrated into Vite. Enable via `environments.*.builder: 'rolldown'` or the `vite-rolldown` package. Not yet default but actively landing.

#### Benchmark app

Use a realistic mid-size app (not a hello-world) to make results meaningful:
- 50+ pages (mix of static, SSR, ISR)
- App Router with nested layouts, parallel routes
- Server Components + "use client" boundary
- `next/image`, `next/font`, metadata API
- Server Actions, route handlers
- Third-party deps (typical: tailwind, a UI library, a data-fetching lib)

This can be derived from a popular Next.js template or our own fixture that exercises all major features.

#### Benchmark harness

- Use [hyperfine](https://github.com/sharkdp/hyperfine) for CLI timing (cold start, build time)
- Use Playwright for HMR latency (save file → measure `page.waitForSelector` of changed content)
- Use [autocannon](https://github.com/mcollina/autocannon) or `wrk` for SSR throughput/TTFB
- Run on a consistent environment (same machine or CI runner with `--prepare` warmup)
- Record results in a markdown table in the repo, or a simple JSON for automated tracking

#### Rolldown-specific notes

Rolldown is the Vite team's Rust-based replacement for Rollup + esbuild (unifying them into one tool). Status as of 2026:
- Available as experimental in Vite via the Rolldown integration
- Expected to become Vite's default bundler (likely Vite 8)
- Key advantages: single Rust toolchain (no JS↔Rust FFI overhead between esbuild and Rollup), faster production builds, better tree-shaking
- For our benchmark: run the same app with both `builder: 'rollup'` and `builder: 'rolldown'` to show the trajectory

#### Expected outcome

We expect Vite to win on cold start and HMR (esbuild/Rolldown is fast, Vite's lazy module evaluation means less upfront work). Build time should be competitive. With Rolldown, production builds should be significantly faster than webpack. Bundle size should be comparable or better (Rollup/Rolldown tree-shaking is excellent).

The benchmark results give us:
1. **Hard numbers for the README** — "X seconds cold start vs Y seconds"
2. **Migration motivation** — developers can see concrete DX improvement
3. **Regression detection** — track these numbers over time to avoid performance regressions
4. **Rolldown readiness signal** — know when Rolldown is stable enough to recommend as default

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
both **real Next.js** and **nextcompat** with identical fixtures. The tests are
black-box: they spin up a server and only assert on HTTP behavior (status,
headers, body, redirects, cookies, cache headers) with no internal hooks.

Why: this catches subtle runtime differences without depending on Next.js
internals or build output. It becomes the contract for:
- `NextRequest`/`NextResponse` semantics
- `redirect()`/`notFound()` behavior
- `cookies()`/`headers()` behavior
- `fetch` caching, `revalidate`, `no-store`
- `basePath`/`i18n`/`trailingSlash` routing

### Third-Party Integration Test Pack (New)

We add a curated set of real-world integrations as black-box tests, each with
an official minimal fixture app:

- `next-auth`
- `@clerk/nextjs`
- `@sentry/nextjs`
- `next-intl`
- `next-themes`
- `next-mdx-remote`

Each fixture is run against Next.js (baseline) and nextcompat. Failures are
triaged and tracked in a public compatibility matrix.

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
     provide wrapper packages (`@nextcompat/auth`, etc.) as a last resort
   - The `npx nextcompat check` tool flags these before migration
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

Part of the docs and surfaced by `nextcompat status` CLI command.

## Routing Behavior Spec (Later)

Deprioritized. A formal routing spec will emerge naturally from the test
harness work and black-box contract tests rather than being written
upfront. We'll codify it once we've learned enough from implementation.

## Non-Goals (Explicit)

- Edge Runtime parity (middleware runs in Node)
- Canary-only Next.js features and unstable internal flags
- Undocumented SWC/Turbopack behaviors
- Provider-specific infrastructure (Vercel-only optimizers or caches)

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
- [`@cloudflare/vite-plugin`](https://www.npmjs.com/package/@cloudflare/vite-plugin) - Cloudflare Workers Vite plugin (310k weekly downloads). Compatible with plugin-rsc via Environment API.
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
