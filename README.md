# vinext

A Vite plugin that reimplements the Next.js API surface so existing Next.js applications can run on Vite and deploy anywhere.

> **Status: Experimental.** This project is under active development. It covers a large portion of the Next.js API but is not yet production-ready. See [API Coverage](#api-coverage) for details.

> **Note:** This project is heavily AI-driven — the majority of the code, tests, and documentation were written with Claude Code (Anthropic's coding agent). Human direction guides architecture, priorities, and design decisions; AI handles implementation.

## Why

Next.js is tightly coupled to Vercel's infrastructure. If you want to deploy to Cloudflare Workers, a $5 VPS, AWS, Fly.io, or anywhere else, you're fighting the framework rather than working with it.

vinext lets you keep your existing Next.js code — pages, layouts, API routes, server components — and run it on Vite. No vendor lock-in. Standard Web APIs. Deploy anywhere.

### Design principles

- **Deploy anywhere by default.** Everything uses standard Web APIs (Request/Response/fetch/streams). If it works on a $5 VPS, it works everywhere.
- **Cloudflare Workers is a first-class target.** Designed to work with `@cloudflare/vite-plugin`.
- **Pragmatic compatibility, not bug-for-bug parity.** Targets 95%+ of real-world Next.js apps. Edge cases that depend on undocumented Vercel behavior are intentionally not supported.
- **Latest Next.js only.** Targets Next.js 16.x. No support for deprecated APIs from older versions.
- **Incremental adoption.** Drop in the plugin, fix what breaks, deploy.

## Quick start

```bash
npm install vinext
```

Replace `next` with `vinext` in your scripts:

```json
{
  "scripts": {
    "dev": "vinext dev",
    "build": "vinext build",
    "start": "vinext start",
    "lint": "vinext lint"
  }
}
```

```bash
vinext dev          # Development server
vinext build        # Production build
vinext start        # Production server
```

That's it. No `vite.config.ts` needed. vinext auto-detects your `app/` or `pages/` directory, loads `next.config.js`, and configures Vite with RSC support automatically.

Your existing `pages/`, `app/`, `next.config.js`, and `public/` directories work as-is.

### CLI reference

| Command | Description |
|---------|-------------|
| `vinext dev` | Start Vite dev server with HMR |
| `vinext build` | Multi-environment production build (RSC + SSR + client) |
| `vinext start` | Start production server with SSR, compression, middleware |
| `vinext lint` | Delegate to eslint (with eslint-config-next) or oxlint |

Options: `-p / --port <port>`, `-H / --hostname <host>`, `--turbopack` (accepted, no-op).

### Deploy to Cloudflare Workers

vinext production builds work on Cloudflare Workers. You need `@cloudflare/vite-plugin`, `@vitejs/plugin-rsc`, and a `vite.config.ts`:

```bash
npm install @cloudflare/vite-plugin @vitejs/plugin-rsc wrangler
```

**`vite.config.ts`**

```ts
import { defineConfig } from "vite";
import vinext from "vinext";
import rsc from "@vitejs/plugin-rsc";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [
    vinext(),
    rsc({
      entries: {
        rsc: "virtual:vinext-rsc-entry",
        ssr: "virtual:vinext-app-ssr-entry",
        client: "virtual:vinext-app-browser-entry",
      },
      loadModuleDevProxy: true,
    }),
    cloudflare({
      viteEnvironment: {
        childEnvironments: ["rsc", "ssr"],
      },
    }),
  ],
});
```

**`wrangler.jsonc`**

```jsonc
{
  "name": "my-app",
  "compatibility_date": "2025-04-01",
  "compatibility_flags": ["nodejs_compat"],
  "main": "./worker/index.ts",
  "assets": { "not_found_handling": "none" }
}
```

**`worker/index.ts`**

```ts
export default {
  async fetch(request: Request): Promise<Response> {
    // @ts-expect-error — injected by @vitejs/plugin-rsc
    const rscModule = await import.meta.viteRsc.loadModule("rsc", "index");
    const result = await rscModule.default(request);
    if (result instanceof Response) return result;
    return new Response("Not Found", { status: 404 });
  },
};
```

Build and deploy:

```bash
npx vite build        # Builds RSC + SSR + client + worker bundles
npx wrangler deploy   # Deploys to Cloudflare Workers
```

> **Note:** Dev mode on Workers is not yet supported (blocked by a `react-server` condition issue in workerd's module runner). Production builds work fully. Use `vinext dev` on Node.js for development.

See `fixtures/cloudflare-app/` for a complete working example.

### Advanced: custom Vite config

If you need custom Vite configuration, create a `vite.config.ts`. vinext will merge its config with yours:

```ts
import { defineConfig } from "vite";
import vinext from "vinext";
import rsc from "@vitejs/plugin-rsc";

export default defineConfig({
  plugins: [
    rsc({
      entries: {
        rsc: "virtual:vinext-rsc-entry",
        ssr: "virtual:vinext-app-ssr-entry",
        client: "virtual:vinext-app-browser-entry",
      },
    }),
    ...vinext(),
  ],
});
```

## API coverage

**~85% of the Next.js API surface has full or partial support.** The remaining gaps are mostly newer experimental features (`"use cache"`, PPR) and build-time optimizations (image resizing, font self-hosting).

The coverage below is against Next.js 16.x.

### Module shims

Every `next/*` import is shimmed to a Vite-compatible implementation.

| Module | Coverage | Notes |
|--------|----------|-------|
| `next/link` | Full | All props including `prefetch` (IntersectionObserver), `onNavigate`, scroll restoration, basePath, `locale` prop for i18n |
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
| `next/form` | Full | GET form interception + POST server action delegation. Re-exports `useActionState` from React 19 |
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
| Middleware (`middleware.ts`) | Full | Matcher patterns (string, array, regex, `:param`, `:path*`, `:path+`), redirect/rewrite/next/custom response |
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
| Server Actions (`"use server"`) | Full | Action execution, FormData, re-render after mutation, `redirect()` in actions |
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
- **Cloudflare Workers dev mode** is not yet supported. Production builds and `wrangler deploy` work. Dev mode is blocked by workerd's module runner not respecting Vite's `react-server` resolve conditions, causing CJS `require("react")` instead of the RSC-specific entry.

## Architecture

vinext is a Vite plugin that:

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
packages/vinext/
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
  cloudflare-app/         # Cloudflare Workers deployment example
  ecosystem/
    app-router-playground/  # Vercel's Next.js App Router Playground running on vinext

tests/
  routing.test.ts         # 45 unit tests
  integration.test.ts     # 497 integration tests
  e2e/                    # 76 Playwright E2E tests
```

## Tests

```bash
npm test              # Run vitest (542 unit + integration tests)
npm run test:e2e      # Run Playwright E2E tests (76 tests)
npm run typecheck     # TypeScript checking (tsgo)
npm run lint          # Linting (oxlint)
```

The test suite covers routing, SSR, API routes, metadata, ISR, server actions (including `useActionState` and redirect-after-action), basePath, middleware matchers, cookies, i18n routing (locale detection, Accept-Language redirect, locale context in getServerSideProps), CSS modules, `next/dynamic`, `next/form`, parameterized redirects/rewrites with catch-all patterns, static export, streaming, client hydration, navigation, error boundaries, and more.

The [Vercel App Router Playground](https://github.com/vercel/next-app-router-playground) runs on vinext as an integration test — all 11 sections render correctly in both dev and production builds.

## Benchmarks

Measured on an 8-core Apple Silicon machine, Node v24.3.0, with a shared 33-route App Router app (nested layouts, dynamic routes, client components, API routes). 3 runs each.

### Production Build Time

| Framework | Mean | StdDev | vs Next.js |
|-----------|------|--------|------------|
| Next.js 16 (Turbopack) | 6.59s | ±169ms | baseline |
| vinext (Vite 7 / Rollup) | 2.43s | ±7ms | **2.7x faster** |
| vinext (Vite 8 / Rolldown) | 946ms | ±16ms | **7.0x faster** |

### Client Bundle Size (gzipped)

| Framework | Files | Gzipped | vs Next.js |
|-----------|-------|---------|------------|
| Next.js 16 | 14 | 168.9 KB | baseline |
| vinext (Rollup) | 3 | 75.4 KB | **55% smaller** |
| vinext (Rolldown) | 4 | 73.8 KB | **56% smaller** |

### Dev Server Cold Start

| Framework | Mean | Peak RSS | vs Next.js |
|-----------|------|----------|------------|
| Next.js 16 (Turbopack) | 2.20s | 87 MB | baseline |
| vinext (Vite 7 / Rollup) | 1.37s | 88 MB | **1.6x faster** |
| vinext (Vite 8 / Rolldown) | 1.21s | 88 MB | **1.8x faster** |

Vite 8 (Rolldown) delivers sub-second production builds — **7x faster** than Next.js 16 with Turbopack. Bundle sizes are consistent between Rollup and Rolldown, both roughly half the size of Next.js output.

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
