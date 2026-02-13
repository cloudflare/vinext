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
| `next/link` | P0 | Medium | Client-side nav, prefetching |
| `next/image` | P1 | High | Image optimization pipeline |
| `next/head` | P0 | Low | Document head management |
| `next/script` | P2 | Low | Third-party script loading |
| `next/router` (Pages) | P1 | High | Full Pages Router compat |
| `next/navigation` (App) | P0 | High | `useRouter`, `usePathname`, `useSearchParams`, `useParams`, `redirect`, `notFound` |
| `next/headers` | P0 | Medium | `cookies()`, `headers()`, `draftMode()` |
| `next/server` | P0 | Medium | `NextRequest`, `NextResponse`, `after()` |
| `next/dynamic` | P1 | Medium | Dynamic imports / code splitting |
| `next/og` | P2 | Medium | OG image generation |
| `next/form` | P2 | Low | Progressive enhancement form |
| `next/font` | P1 | High | Font optimization |
| `next/document` | P1 | Low | Pages Router only |
| `next/app` | P1 | Low | Pages Router only |

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
| `pages/` directory | P1 | Legacy Pages Router |
| `pages/api/` | P1 | Legacy API routes |
| `middleware.ts` | P1 | Edge middleware |

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

### Phase 0: Foundation (Week 1-2)

**Goal**: `hello-world` example renders correctly.

- [ ] Scaffold the Vite plugin structure
- [ ] Implement `app/` directory file-system routing (basic)
  - `page.tsx` and `layout.tsx` discovery
  - Dynamic route segments `[param]`
- [ ] Implement basic SSR rendering pipeline
  - Server-side React rendering to HTML
  - Client hydration bundle generation
- [ ] Implement `next/head` shim
- [ ] Implement `next/link` shim (basic - just renders `<a>` with client nav)
- [ ] Create CLI: `nextcompat dev` wrapping `vite dev` with our plugin
- [ ] **Validation**: `hello-world` example renders, navigates

### Phase 1: Core App Router (Week 3-5)

**Goal**: Most simple App Router examples work. Begin test harness.

- [ ] RSC support (server/client component boundary via `'use client'`)
- [ ] `app/route.ts` API route handlers (GET, POST, etc.)
- [ ] `next/navigation` hooks (`useRouter`, `usePathname`, `useSearchParams`)
- [ ] `next/headers` (`cookies()`, `headers()`)
- [ ] `next/server` (`NextRequest`, `NextResponse`)
- [ ] `app/loading.tsx` (Suspense boundaries)
- [ ] `app/error.tsx` (Error boundaries)
- [ ] `app/not-found.tsx`
- [ ] CSS Modules support (Vite handles this natively)
- [ ] `next.config.js` parsing (basic: `env`, `basePath`)
- [ ] **Validation**: `basic-css`, `next-forms`, `reproduction-template` examples
- [ ] **Test harness**: Extract and adapt Next.js e2e test infrastructure

### Phase 2: Pages Router + Production (Week 6-8)

**Goal**: Pages Router works. Production builds work.

- [ ] `pages/` directory routing
- [ ] `getServerSideProps`, `getStaticProps`, `getStaticPaths`
- [ ] `pages/api/` routes
- [ ] `_app.tsx`, `_document.tsx`, `_error.tsx`
- [ ] `next/router` (Pages Router `useRouter`)
- [ ] `nextcompat build` (production build via `vite build`)
- [ ] `nextcompat start` (production server)
- [ ] Static generation (SSG)
- [ ] `next/dynamic` (dynamic imports)
- [ ] `next/image` (basic - proxy + resize, not full optimization)
- [ ] **Validation**: Pages Router examples, `api-routes-rest`
- [ ] **Test harness**: Begin running e2e tests, track pass rate

### Phase 3: Advanced Features (Week 9-12)

**Goal**: Majority of e2e tests passing.

- [ ] Server Actions (`'use server'`)
- [ ] Middleware (`middleware.ts`)
- [ ] Streaming SSR
- [ ] `next/font` optimization
- [ ] `rewrites`, `redirects`, `headers` in config
- [ ] Route groups, catch-all routes, optional catch-all
- [ ] `output: 'export'` (static export)
- [ ] ISR (Incremental Static Regeneration)
- [ ] `next/og` (OG image generation)
- [ ] `next/script`
- [ ] **Validation**: Target 50%+ of e2e test suite passing

### Phase 4: Parity Push (Week 13+)

**Goal**: Maximize e2e test pass rate. Production-ready.

- [ ] Parallel routes (`@slot`)
- [ ] Intercepting routes
- [ ] i18n routing
- [ ] Full `next/image` optimization pipeline
- [ ] Edge runtime compatibility
- [ ] `next.config.js` full compatibility
- [ ] Performance optimization (bundle size, cold start, HMR speed)
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

1. `test/e2e/app-dir/` - App Router basics (largest surface area)
2. `test/e2e/middleware-general/` - Middleware
3. `test/production/` - Production build correctness
4. `test/development/` - Dev server / HMR
5. `test/e2e/pages-dir/` - Pages Router (if we pursue compat)

## Open Questions

1. ~~**RSC bundling**~~ **RESOLVED**: `@vitejs/plugin-rsc` (official Vite
   plugin) handles the full RSC pipeline. It provides three environments
   (`rsc`, `ssr`, `client`), handles `'use server'`/`'use client'` directive
   boundaries, RSC stream serialization/deserialization, CSS code-splitting
   across server/client, and HMR for server components. We build on top of
   this rather than rolling our own. It even supports `"use cache"` already.

2. **Scope of Pages Router support**: Do we go full compat, or declare it
   out of scope and focus on App Router only? Pages Router is legacy but
   still widely used.

3. **`next/image` optimization**: Next.js has a full image optimization
   pipeline (Sharp-based). Do we reimplement it, or use an existing Vite
   image plugin and just shim the component?

4. **Edge Runtime**: Next.js middleware runs in an Edge-like environment.
   Do we need to emulate this, or can we run middleware in Node and accept
   minor behavioral differences?

5. **Turbopack-specific behaviors**: Are there behaviors that only exist
   because of Turbopack that we'd need to replicate, or can we treat the
   public API as the contract?

6. **Name**: `nextcompat`? `vite-plugin-next`? `unnext`? `vixt`?

## Success Criteria

- **Phase 0**: `hello-world` renders. We know this is feasible.
- **Phase 1**: 5+ official examples work unmodified.
- **Phase 2**: Production builds work. Pages Router basics work.
- **Phase 3**: 50%+ of Next.js e2e tests pass.
- **Phase 4**: 80%+ pass rate. Real-world apps can migrate.

## Prior Art & References

- [Vike](https://vike.dev/) - Vite-based SSR framework (different API)
- [Vinxi](https://vinxi.vercel.app/) - Framework-agnostic server layer on Vite/Nitro
- [TanStack Start](https://tanstack.com/start) - Full-stack React on Vite (different API)
- [Waku](https://waku.gg/) - Minimal RSC framework on Vite
- Next.js repo: https://github.com/vercel/next.js
- Next.js e2e tests: `test/e2e/`, especially `test/e2e/app-dir/`
- Existing POC: AI chatbot example (internal, built by team member)
