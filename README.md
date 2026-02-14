# nextcompat

A Vite plugin that reimplements the Next.js API surface so existing Next.js applications can run on Vite and deploy anywhere.

> **Status: Experimental.** This project is under active development. It covers a large portion of the Next.js API but is not yet production-ready. See [API Coverage](#api-coverage) for details.

> **Note:** This project is heavily AI-driven — the majority of the code, tests, and documentation were written with Claude Code (Anthropic's coding agent). Human direction guides architecture, priorities, and design decisions; AI handles implementation.

## Why

Next.js is tightly coupled to Vercel's infrastructure. If you want to deploy to Cloudflare Workers, a $5 VPS, AWS, Fly.io, or anywhere else, you're fighting the framework rather than working with it.

nextcompat lets you keep your existing Next.js code — pages, layouts, API routes, server components — and run it on Vite. No vendor lock-in. Standard Web APIs. Deploy anywhere.

### Design principles

- **Deploy anywhere by default.** Everything uses standard Web APIs (Request/Response/fetch/streams). If it works on a $5 VPS, it works everywhere.
- **Cloudflare Workers is a first-class target.** Designed to work with `@cloudflare/vite-plugin`.
- **Pragmatic compatibility, not bug-for-bug parity.** Targets 95%+ of real-world Next.js apps. Edge cases that depend on undocumented Vercel behavior are intentionally not supported.
- **Latest Next.js only.** Targets Next.js 16.x. No support for deprecated APIs from older versions.
- **Incremental adoption.** Drop in the plugin, fix what breaks, deploy.

## Quick start

```bash
npm install vite-plugin-nextcompat vite @vitejs/plugin-rsc
```

Create a `vite.config.ts`:

```ts
import { defineConfig } from "vite";
import nextcompat from "vite-plugin-nextcompat";
import rsc from "@vitejs/plugin-rsc";

export default defineConfig({
  plugins: [
    // Pages Router only — just nextcompat:
    ...nextcompat(),

    // App Router — add the RSC plugin:
    rsc({
      entries: {
        rsc: "virtual:nextcompat-rsc-entry",
        ssr: "virtual:nextcompat-app-ssr-entry",
        client: "virtual:nextcompat-app-browser-entry",
      },
    }),
  ],
});
```

```bash
npx vite dev        # Development server
npx vite build      # Production build
npx vite preview    # Preview production build
```

Your existing `pages/`, `app/`, `next.config.js`, and `public/` directories work as-is.

## API coverage

**~85% of the Next.js API surface has full or partial support.** The remaining gaps are mostly newer experimental features (`"use cache"`, PPR) and build-time optimizations (image resizing, font self-hosting).

The coverage below is against Next.js 16.x.

### Module shims

Every `next/*` import is shimmed to a Vite-compatible implementation.

| Module | Coverage | Notes |
|--------|----------|-------|
| `next/link` | Full | All props including `prefetch` (IntersectionObserver), `onNavigate`, scroll restoration, basePath |
| `next/image` | Partial | Remote images via [@unpic/react](https://unpic.pics) (28 CDNs). Local images via `<img>` + srcSet. No build-time optimization/resizing |
| `next/head` | Full | SSR collection + client-side DOM manipulation |
| `next/router` | Full | `useRouter`, `Router` singleton, events, client-side navigation, SSR context, i18n |
| `next/navigation` | Full | `usePathname`, `useSearchParams`, `useParams`, `useRouter`, `redirect`, `notFound`, `forbidden`, `unauthorized` |
| `next/server` | Full | `NextRequest`, `NextResponse`, `NextURL`, cookies, `userAgent`, `after`, `connection`, `URLPattern` |
| `next/headers` | Full | Async `headers()`, `cookies()`, `draftMode()` (Next.js 15+/16 style) |
| `next/dynamic` | Full | `ssr: true`, `ssr: false`, `loading` component |
| `next/script` | Full | All 4 strategies (`beforeInteractive`, `afterInteractive`, `lazyOnload`, `worker`) |
| `next/font/google` | Partial | Runtime CDN loading. No self-hosting, font subsetting, or fallback metrics |
| `next/font/local` | Partial | Runtime `@font-face` injection. Not extracted at build time |
| `next/og` | Full | Real implementation via [Satori](https://github.com/vercel/satori) + resvg — generates actual PNG images |
| `next/cache` | Partial | `revalidateTag`, `revalidatePath`, `unstable_cache`, pluggable `CacheHandler`. `"use cache"` directive not supported |
| `next/form` | Full | GET form interception + POST server action delegation |
| `next/legacy/image` | Full | Translates legacy props to modern Image |
| `next/error` | Full | Default error page component |
| `next/config` | Full | `getConfig` / `setConfig` |
| `next/document` | Full | `Html`, `Head`, `Main`, `NextScript` |
| `next/constants` | Full | All phase constants |
| `next/amp` | Stub | No-op (AMP is deprecated) |
| `next/web-vitals` | Stub | No-op (use the `web-vitals` library directly) |

### Routing

| Feature | Coverage | Notes |
|---------|----------|-------|
| File-system routing (`pages/`) | Full | Automatic scanning with hot-reload on file changes |
| File-system routing (`app/`) | Full | Pages, routes, layouts, templates, loading, error, not-found, forbidden, unauthorized |
| Dynamic routes `[param]` | Full | Both routers |
| Catch-all `[...slug]` | Full | Both routers |
| Optional catch-all `[[...slug]]` | Full | Both routers |
| Route groups `(group)` | Full | URL-transparent, layouts still apply |
| Parallel routes `@slot` | Full | Discovery, layout props, `default.tsx`, inherited slots |
| Intercepting routes | Full | `(.)`, `(..)`, `(..)(..)`, `(...)` conventions |
| Route handlers (`route.ts`) | Full | Named HTTP methods, auto OPTIONS/HEAD, cookie attachment |
| Middleware (`middleware.ts`) | Full | Matcher patterns, redirect/rewrite/next/custom response |
| i18n routing | Partial | Pages Router locale prefix + Accept-Language detection. No domain-based routing |
| `basePath` | Full | Applied everywhere — URLs, Link, Router, navigation hooks |
| `trailingSlash` | Full | 308 redirects to canonical form |

### Server features

| Feature | Coverage | Notes |
|---------|----------|-------|
| SSR (Pages Router) | Full | Streaming, `_app`/`_document`, `__NEXT_DATA__`, hydration |
| SSR (App Router) | Full | RSC pipeline, nested layouts, streaming, nav context for client components |
| `getStaticProps` | Full | Props, redirect, notFound, revalidate |
| `getStaticPaths` | Full | `fallback: false`, `true`, `"blocking"` |
| `getServerSideProps` | Full | Full context including locale |
| ISR | Full | Stale-while-revalidate, pluggable `CacheHandler`, background regeneration |
| Server Actions (`"use server"`) | Full | Action execution, FormData, re-render after mutation |
| React Server Components | Full | Via `@vitejs/plugin-rsc`. `"use client"` boundaries work correctly |
| Streaming SSR | Full | Both routers |
| Metadata API | Full | `metadata`, `generateMetadata`, `viewport`, `generateViewport`, title templates |
| `generateStaticParams` | Full | With `dynamicParams` enforcement |
| Metadata file routes | Full | sitemap.xml, robots.txt, manifest, favicon, OG images (static + dynamic) |
| Static export (`output: 'export'`) | Partial | Core functions exist, not yet a standalone CLI command |
| Route segment config | Partial | `revalidate`, `dynamic`, `dynamicParams`. Missing: `runtime`, `preferredRegion` |
| `"use cache"` directive | Not yet | `cacheLife()` and `cacheTag()` are no-ops |
| PPR (Partial Prerendering) | Not yet | |

### Configuration

| Feature | Coverage | Notes |
|---------|----------|-------|
| `next.config.js` / `.ts` / `.mjs` | Full | Function configs, phase argument |
| `rewrites` / `redirects` / `headers` | Full | All phases, param interpolation |
| Environment variables (`NEXT_PUBLIC_*`) | Full | Inlined at build time via Vite |
| `images` config | Partial | Parsed but not used for optimization |

### Caching

The cache is **pluggable**. The default `MemoryCacheHandler` works out of the box. Swap in your own backend for production:

```ts
import { setCacheHandler } from "next/cache";

// Example: Redis, Cloudflare KV, DynamoDB, etc.
setCacheHandler(new MyCacheHandler());
```

The `CacheHandler` interface matches Next.js 16's shape, so community adapters should be compatible.

## What's NOT supported (and won't be)

These are intentional exclusions, not bugs:

- **Vercel-specific features** — `@vercel/og` edge runtime, Vercel Analytics integration, Vercel KV/Blob/Postgres bindings. Use the platform-agnostic equivalents.
- **AMP** — Deprecated since Next.js 13. `useAmp()` returns `false`.
- **`next export` (legacy)** — Use `output: 'export'` in config instead.
- **Turbopack/webpack configuration** — This runs on Vite. Use Vite plugins instead of webpack loaders/plugins.
- **`next/jest`** — Use Vitest.
- **`create-next-app` scaffolding** — Not a goal.
- **Bug-for-bug parity with undocumented behavior** — If it's not in the Next.js docs, we probably don't replicate it.

## What's experimental / known limitations

- **`"use cache"` is not supported.** The directive is stripped (treated as a no-op) so apps don't crash, but caching doesn't happen. This is a Next.js 15+ feature that's becoming important in 16.
- **Image optimization doesn't happen at build time.** Remote images work great via `@unpic/react` (auto-detects 28 CDN providers). Local images are served as-is without resizing or format conversion.
- **Google Fonts are loaded from the CDN, not self-hosted.** This means no `size-adjust` fallback font metrics and a dependency on Google's CDN at runtime. Local fonts work but `@font-face` CSS is injected at runtime.
- **`useSelectedLayoutSegment(s)`** derives segments from the pathname rather than being truly layout-aware. Works correctly in most cases but may differ from Next.js in edge cases with parallel routes.
- **PPR (Partial Prerendering)** is not implemented. This is still experimental in Next.js itself.
- **Route segment config** — `runtime` and `preferredRegion` are ignored (everything runs in the same Node.js process / Worker).
- **Production builds work** but haven't been as battle-tested as dev mode. The build uses Vite's `createBuilder` API with `@vitejs/plugin-rsc` for multi-environment output (RSC + SSR + client).

## Architecture

nextcompat is a Vite plugin that:

1. **Resolves all `next/*` imports** to local shim modules that reimplement the Next.js API using standard Web APIs and React primitives.
2. **Scans your `pages/` and `app/` directories** to build a file-system router matching Next.js conventions.
3. **Generates virtual entry modules** for the RSC, SSR, and browser environments that handle request routing, component rendering, and client hydration.
4. **Integrates with `@vitejs/plugin-rsc`** for React Server Components — handling `"use client"` / `"use server"` directives, RSC stream serialization, and multi-environment builds.

The result is a standard Vite application that happens to be API-compatible with Next.js.

### Pages Router flow

```
Request → Vite dev server middleware → Route match → getServerSideProps/getStaticProps
  → renderToPipeableStream(App + Page) → HTML with __NEXT_DATA__ → Client hydration
```

### App Router flow

```
Request → RSC entry (Vite rsc environment) → Route match → Build layout/page tree
  → renderToReadableStream (RSC payload) → SSR entry (Vite ssr environment)
  → renderToReadableStream (HTML) → Client hydration from RSC stream
```

## Project structure

```
packages/vite-plugin-nextcompat/
  src/
    index.ts              # Main plugin — resolve aliases, config, virtual modules
    routing/
      pages-router.ts     # Pages Router file-system scanner
      app-router.ts       # App Router file-system scanner
    server/
      dev-server.ts       # Pages Router SSR request handler
      app-dev-server.ts   # App Router RSC entry generator
      prod-server.ts      # Production server with compression
      api-handler.ts      # Pages Router API routes
      isr-cache.ts        # ISR cache layer
      middleware.ts        # middleware.ts runner
      metadata-routes.ts  # File-based metadata route scanner
      instrumentation.ts  # instrumentation.ts support
    shims/                # One file per next/* module
    build/
      static-export.ts    # output: 'export' support
    config/
      next-config.ts      # next.config.js loader

fixtures/                 # Test fixtures
  pages-basic/            # Pages Router test app
  app-basic/              # App Router test app
  ecosystem/
    app-router-playground/  # Vercel's Next.js App Router Playground running on nextcompat

tests/
  routing.test.ts         # 41 unit tests
  integration.test.ts     # 335 integration tests
  e2e/                    # 51 Playwright E2E tests
```

## Tests

```bash
npm test              # Run vitest (376 unit + integration tests)
npm run test:e2e      # Run Playwright E2E tests (51 tests)
npm run typecheck     # TypeScript checking (tsgo)
npm run lint          # Linting (oxlint)
```

The test suite covers routing, SSR, API routes, metadata, ISR, server actions, static export, streaming, client hydration, navigation, error boundaries, and more.

The [Vercel App Router Playground](https://github.com/vercel/next-app-router-playground) runs on nextcompat as an integration test — all 11 sections render correctly in both dev and production builds.

## Benchmarks

Measured on an 8-core Apple Silicon machine, Node v24.3.0, with a shared 33-route App Router app (nested layouts, dynamic routes, client components, API routes). 3 runs each.

| Metric | Next.js 16 (Turbopack) | nextcompat (Vite 7) | Delta |
|--------|----------------------|--------------------|----|
| Production build | 5.43s ±99ms | 2.09s ±13ms | **2.6x faster** |
| Client bundle (gzip) | 168.9 KB (14 files) | 75.4 KB (3 files) | **55% smaller** |
| Dev cold start | 1.72s | 1.16s | **33% faster** |
| Dev peak RSS | 88 MB | 88 MB | Same |

Reproduce with:

```bash
node benchmarks/run.mjs --runs=3
```

The benchmark uses `hyperfine` for build timing (falls back to manual `performance.now()` measurement), `gzipSync` for bundle size, and process RSS polling for memory. SSR throughput benchmarks (autocannon) are planned but require production server wiring.

## Compatibility estimate

Based on a systematic audit of the Next.js 16 API surface:

| | Count | Percentage |
|---|---|---|
| Full implementation | 28 features | 58% |
| Partial implementation | 13 features | 27% |
| Intentional stubs (deprecated/unnecessary) | 4 features | 8% |
| Not yet implemented | 3 features | 6% |

**~85% of the API surface has full or partial support.** The three unimplemented features (`"use cache"`, PPR, and full build-time image optimization) are either experimental in Next.js itself or require deep integration with a build pipeline.

For a typical Next.js application that uses:
- Pages Router or App Router (or both)
- Dynamic routes, layouts, loading/error states
- Server-side rendering and API routes
- `next/link`, `next/image`, `next/head`, `next/navigation`
- Middleware, rewrites, redirects
- Server Actions

...the migration path should be straightforward. Install the plugin, run `vite dev`, and fix any import issues.

## Contributing

This project is experimental and under active development. Issues and PRs are welcome.

## License

MIT
