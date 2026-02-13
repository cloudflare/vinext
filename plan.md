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

## Why This Might Actually Work

- Vite already handles JSX/TSX, CSS Modules, HMR, code splitting, SSR
- React Server Components have a spec independent of Next.js
- Most of Next's "magic" is file-system conventions + a rendering pipeline
- The hard parts (bundling, transforms, dev server) are what Vite is best at
- Next.js's test suite is public and comprehensive - we have a concrete target

## Architecture

```
nextcompat (Vite plugin)
├── vite-plugin-nextcompat     # Core Vite plugin
│   ├── routing/               # File-system router (app/ and pages/ conventions)
│   ├── rendering/             # SSR + RSC rendering pipeline
│   ├── server/                # Dev server + production server
│   ├── api/                   # API route handlers
│   └── shims/                 # next/* module shims (next/link, next/image, etc.)
├── nextcompat-cli             # `nextcompat dev`, `nextcompat build`, `nextcompat start`
└── test-harness/              # Adapted Next.js e2e test runner
```

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

Track progress with a dashboard:
- Total tests: N
- Passing: X
- Failing: Y
- Skipped (intentionally unsupported): Z

### Test Categories to Prioritize

1. `test/e2e/app-dir/` - App Router basics (largest surface area)
2. `test/e2e/middleware-general/` - Middleware
3. `test/production/` - Production build correctness
4. `test/development/` - Dev server / HMR
5. `test/e2e/pages-dir/` - Pages Router (if we pursue compat)

## Open Questions

1. **RSC bundling**: Vite doesn't natively handle the RSC wire format.
   Do we use `react-server-dom-webpack` (which has a Vite-compatible layer
   via `@vitejs/plugin-react`)? Or do we need a custom RSC bundler plugin?
   This is probably the single hardest technical challenge.

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
