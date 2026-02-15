# vinext

Run your Next.js app on Cloudflare Workers. One command to deploy.

> **Status: Experimental.** Under active development. Covers ~85% of the Next.js API surface. See [API Coverage](#api-coverage) for details.

> **Note:** This project is heavily AI-driven — the majority of the code, tests, and documentation were written with Claude Code (Anthropic's coding agent). Human direction guides architecture, priorities, and design decisions; AI handles implementation.

## Why

Next.js is locked to Vercel. Cloudflare Workers is a better runtime —
zero cold starts, global by default, integrated platform (KV, R2, D1, AI) —
but you can't run Next.js on it without fighting OpenNext adapters that
constantly lag behind.

vinext reimplements the Next.js API surface on Vite, with Cloudflare Workers
as the primary deployment target. Keep your existing Next.js code — pages,
layouts, API routes, server components — and deploy to Workers. No adapter
layer. No compatibility hacks. A clean build from scratch.

### Design principles

- **Cloudflare-first.** Workers is THE deployment target. Every feature is built and tested for Workers. If it also works on Node.js, that's a bonus.
- **Near-full Node.js compatibility.** Workers with `nodejs_compat` supports ~85% of Node APIs. `node:fs` is built-in ([docs](https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/)) and can be extended with persistent mounts via [`worker-fs-mount`](https://github.com/danlapid/worker-fs-mount) (R2, Durable Objects backends).
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
vinext dev          # Development server (runs in workerd via Cloudflare plugin)
vinext build        # Production build (worker + client bundles)
vinext start        # Local production server (for testing)
```

That's it. No `vite.config.ts` needed. vinext auto-detects your `app/` or `pages/` directory, loads `next.config.js`, and configures Vite with RSC support automatically.

Your existing `pages/`, `app/`, `next.config.js`, and `public/` directories work as-is.

### CLI reference

| Command | Description |
|---------|-------------|
| `vinext dev` | Start dev server with HMR (workerd runtime via Cloudflare plugin) |
| `vinext build` | Multi-environment production build (RSC + SSR + client + worker) |
| `vinext start` | Start local production server for testing |
| `vinext lint` | Delegate to eslint (with eslint-config-next) or oxlint |

Options: `-p / --port <port>`, `-H / --hostname <host>`, `--turbopack` (accepted, no-op).

## Deploy to Cloudflare Workers

Cloudflare Workers is the primary deployment target. Both App Router and Pages Router work on Workers.

#### App Router on Workers

You need `@cloudflare/vite-plugin`, `@vitejs/plugin-rsc`, and a `vite.config.ts`:

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
  "compatibility_date": "2026-02-12",
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

See `fixtures/cloudflare-app/` for a complete working example.

#### Pages Router on Workers

Pages Router apps can also deploy to Workers. No RSC plugin needed:

```bash
npm install @cloudflare/vite-plugin wrangler
```

**`vite.config.ts`**

```ts
import { defineConfig } from "vite";
import vinext from "vinext";
import { cloudflare } from "@cloudflare/vite-plugin";

export default defineConfig({
  plugins: [
    vinext(),
    cloudflare(),
  ],
});
```

**`wrangler.jsonc`**

```jsonc
{
  "name": "my-pages-app",
  "compatibility_date": "2026-02-12",
  "compatibility_flags": ["nodejs_compat"],
  "main": "./worker/index.ts"
}
```

**`worker/index.ts`**

```ts
import { renderPage, handleApiRoute } from "virtual:vinext-server-entry";

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      const apiResponse = await handleApiRoute(request, url);
      if (apiResponse) return apiResponse;
    }
    const manifest = {};
    const response = await renderPage(request, url, manifest);
    if (response) return response;
    return new Response("Not Found", { status: 404 });
  },
};
```

See `fixtures/cloudflare-pages/` for a complete working example.

> Both Pages Router and App Router have full client-side hydration on Workers. Interactive components, client-side navigation, and React state all work.

#### Cloudflare KV Cache Handler

For production ISR/caching on Workers, use the built-in KV cache handler:

```ts
import { KVCacheHandler } from "vinext/cloudflare";

// In your worker entry:
const cacheHandler = new KVCacheHandler(env.MY_KV_NAMESPACE);
```

#### Node.js compatibility on Workers

Workers with `nodejs_compat` supports ~85% of Node.js APIs. `node:fs` is
built-in with a virtual filesystem (`/bundle/` for read-only bundle access,
`/tmp/` for per-request writes). For persistent filesystem operations, use
[`worker-fs-mount`](https://github.com/danlapid/worker-fs-mount) to mount
R2 or Durable Object storage behind standard `fs.readFile`/`fs.writeFile`
APIs. [Cloudflare node:fs docs](https://developers.cloudflare.com/workers/runtime-apis/nodejs/fs/).

#### Build and deploy

```bash
npx vite build        # Builds worker + client bundles
npx wrangler deploy   # Deploys to Cloudflare Workers
```

Both `wrangler dev` (local dev with miniflare) and `npx vite dev` (Vite dev server) work for local development.

> **Coming soon: `vinext deploy`** — a single command that handles build + deploy + auto-generates wrangler config and worker entry if they don't exist. Zero manual setup.

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
| i18n routing | Partial | Pages Router locale prefix, Accept-Language detection, NEXT_LOCALE cookie, `locale` prop on Link + router.push/replace. No domain-based routing |
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

// Example: Redis, DynamoDB, etc.
setCacheHandler(new MyCacheHandler());
```

For Cloudflare Workers, use the built-in KV cache handler:

```ts
import { KVCacheHandler } from "vinext/cloudflare";
setCacheHandler(new KVCacheHandler(env.MY_KV_NAMESPACE));
```

The `CacheHandler` interface matches Next.js 16's shape, so community adapters should be compatible.

## What's NOT supported (and won't be)

These are intentional exclusions, not bugs:

- **Vercel-specific features** — `@vercel/og` edge runtime, Vercel Analytics integration, Vercel KV/Blob/Postgres bindings. Use Cloudflare equivalents (KV, R2, D1).
- **AMP** — Deprecated since Next.js 13. `useAmp()` returns `false`.
- **`next export` (legacy)** — Use `output: 'export'` in config instead.
- **Turbopack/webpack configuration** — This runs on Vite. Use Vite plugins instead of webpack loaders/plugins.
- **`next/jest`** — Use Vitest.
- **`create-next-app` scaffolding** — Not a goal.
- **Non-Cloudflare deployment targets** — AWS Lambda, Netlify Functions, generic Node.js servers are not tested or maintained. If they happen to work, great. We won't break them gratuitously, but we won't block Cloudflare features to maintain compatibility.
- **Bug-for-bug parity with undocumented behavior** — If it's not in the Next.js docs, we probably don't replicate it.

## What's experimental / known limitations

- **`"use cache"` is not supported.** The directive is stripped (treated as a no-op) so apps don't crash, but caching doesn't happen. This is a Next.js 15+ feature that's becoming important in 16.
- **Image optimization doesn't happen at build time.** Remote images work great via `@unpic/react` (auto-detects 28 CDN providers). Local images are served as-is without resizing or format conversion.
- **Google Fonts are loaded from the CDN, not self-hosted.** This means no `size-adjust` fallback font metrics and a dependency on Google's CDN at runtime. Local fonts work but `@font-face` CSS is injected at runtime.
- **`useSelectedLayoutSegment(s)`** derives segments from the pathname rather than being truly layout-aware. Works correctly in most cases but may differ from Next.js in edge cases with parallel routes.
- **PPR (Partial Prerendering)** is not implemented. This is still experimental in Next.js itself.
- **Route segment config** — `runtime` and `preferredRegion` are ignored (everything runs in the same Node.js process / Worker).
- **Production builds work** but haven't been as battle-tested as dev mode. The build uses Vite's `createBuilder` API with `@vitejs/plugin-rsc` for multi-environment output (RSC + SSR + client).
- **Cloudflare Workers dev mode works** for both App Router and Pages Router via `wrangler dev` / `npx vite dev`. Production builds and `wrangler deploy` also work.
- **Both routers have full hydration on Workers.** Client JS bundles are built alongside the worker and served via Workers Assets.

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
  → renderToReadableStream(App + Page) → HTML with __NEXT_DATA__ → Client hydration
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
    cli.ts                # vinext CLI (dev/build/start/lint)
    routing/
      pages-router.ts     # Pages Router file-system scanner
      app-router.ts       # App Router file-system scanner
    server/
      dev-server.ts       # Pages Router SSR request handler (Web Request/Response)
      app-dev-server.ts   # App Router RSC entry generator
      prod-server.ts      # Production server with compression
      api-handler.ts      # Pages Router API routes
      isr-cache.ts        # ISR cache layer
      middleware.ts        # middleware.ts runner
      metadata-routes.ts  # File-based metadata route scanner
      instrumentation.ts  # instrumentation.ts support
    cloudflare/
      kv-cache-handler.ts # Cloudflare KV-backed CacheHandler for ISR
    shims/                # One file per next/* module
    build/
      static-export.ts    # output: 'export' support
    config/
      next-config.ts      # next.config.js loader

fixtures/                 # Test fixtures
  pages-basic/            # Pages Router test app
  app-basic/              # App Router test app
  cloudflare-app/         # App Router on Cloudflare Workers
  cloudflare-pages/       # Pages Router on Cloudflare Workers
  ecosystem/
    app-router-playground/  # Vercel's Next.js App Router Playground running on vinext

tests/
  routing.test.ts         # Route scanning unit tests
  shims.test.ts           # Module shim tests (incl. KV cache handler)
  pages-router.test.ts    # Pages Router integration tests
  app-router.test.ts      # App Router integration tests
  features.test.ts        # Cross-cutting feature tests
  ecosystem.test.ts       # Ecosystem library tests
  e2e/                    # Playwright E2E tests
    app-router/           # App Router E2E (64 tests)
    pages-router/         # Pages Router E2E (22 tests)
    cloudflare-pages-router/  # Pages Router on Workers E2E (13 tests)
```

## Tests

```bash
npm test              # Run vitest (638 unit + integration tests)
npm run test:e2e      # Run Playwright E2E tests (117+ tests across 5 projects)
npm run typecheck     # TypeScript checking (tsgo)
npm run lint          # Linting (oxlint)
```

The test suite covers routing, SSR, API routes, metadata, ISR, server actions (including `useActionState` and redirect-after-action), basePath, middleware matchers, cookies, i18n routing (locale detection, Accept-Language redirect, NEXT_LOCALE cookie override, locale context in getServerSideProps), CSS modules, `next/dynamic` (including error handling), `next/form` GET interception, parameterized redirects/rewrites with catch-all patterns, chained middleware → config rewrites, GSSP redirect statusCode variants, static export, streaming, client hydration, navigation, error boundaries, and more.

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
